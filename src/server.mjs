#!/usr/bin/env node
/**
 * Huly HTTP REST Server - entry point for n8n, curl, and scripts.
 *
 * Uses built-in Node.js http module (no Express dependency).
 * Workspace can be specified per-request via X-Huly-Workspace header
 * or ?workspace= query parameter.
 *
 * Features:
 * - Bearer token authentication (optional, via MCP_AUTH_TOKEN)
 * - Rate limiting (configurable via HULY_RATE_LIMIT, default 100 req/min)
 * - SSE endpoint for real-time issue change notifications
 * - OpenAPI spec at /api/openapi.json
 */

import { createServer } from 'http';
import crypto from 'node:crypto';
import { pool } from './pool.mjs';
import { HulyClient } from './client.mjs';

const PORT = parseInt(process.env.PORT || '3001', 10);
const API_TOKEN = process.env.MCP_AUTH_TOKEN || null;
const RATE_LIMIT = parseInt(process.env.HULY_RATE_LIMIT || '100', 10); // requests per minute
const RATE_WINDOW_MS = 60000;
const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
const HULY_TOKEN = process.env.HULY_TOKEN;
const HULY_EMAIL = process.env.HULY_EMAIL;
const HULY_PASSWORD = process.env.HULY_PASSWORD;
const HULY_CREDS = HULY_TOKEN ? { token: HULY_TOKEN } : { email: HULY_EMAIL, password: HULY_PASSWORD };
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// ── Rate Limiting ─────────────────────────────────────────────

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitStore = new Map();

/**
 * Check rate limit for a client IP. Returns true if allowed.
 * @param {string} ip
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - entry.count),
    resetAt: entry.resetAt
  };
}

// Periodic cleanup of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ── SSE Connections ───────────────────────────────────────────

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();
const MAX_SSE_CLIENTS = 100;

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event - Event name
 * @param {*} data - Event data (will be JSON-stringified)
 */
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Parse JSON body from an incoming request.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Object>}
 */
const MAX_BODY_SIZE = 1048576; // 1MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return reject(new Error('Empty request body'));
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {*} data
 */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Extract workspace from request (header > query param > env default).
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @returns {string|undefined}
 */
function getWorkspace(req, url) {
  return req.headers['x-huly-workspace'] || url.searchParams.get('workspace') || undefined;
}

/**
 * Match a URL path against a pattern with named params.
 * @param {string} pattern
 * @param {string} pathname
 * @returns {Object|null}
 */
function matchRoute(pattern, pathname) {
  const patParts = pattern.split('/');
  const urlParts = pathname.split('/');

  if (patParts.length !== urlParts.length) return null;

  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Wrap a client operation to broadcast SSE events for mutations.
 * @param {string} event - Event type (e.g., "issue.created")
 * @param {Function} operation - Async operation that returns result
 * @returns {Promise<*>}
 */
async function withSSE(event, operation) {
  const result = await operation();
  if (sseClients.size > 0) {
    broadcastSSE(event, result);
  }
  return result;
}

// ── OpenAPI Spec ──────────────────────────────────────────────

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Huly API',
    description: 'REST API for Huly issue tracking with multi-workspace support',
    version: '2.0.0'
  },
  servers: [{ url: `http://localhost:${PORT}`, description: 'Local server' }],
  security: API_TOKEN ? [{ bearerAuth: [] }] : [],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Set MCP_AUTH_TOKEN env var to enable. Pass as Authorization: Bearer <token>'
      }
    },
    parameters: {
      workspace: {
        name: 'X-Huly-Workspace',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Workspace slug (falls back to HULY_WORKSPACE env var)'
      },
      workspaceQuery: {
        name: 'workspace',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Workspace slug (alternative to header)'
      }
    }
  },
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: { '200': { description: 'Server is healthy' } }
      }
    },
    '/api/projects': {
      get: {
        summary: 'List all projects',
        tags: ['Projects'],
        parameters: [{ $ref: '#/components/parameters/workspace' }],
        responses: { '200': { description: 'Array of projects' } }
      },
      post: {
        summary: 'Create a new project',
        tags: ['Projects'],
        parameters: [{ $ref: '#/components/parameters/workspace' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identifier', 'name'],
                properties: {
                  identifier: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  private: { type: 'boolean' }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Created project' } }
      }
    },
    '/api/projects/{identifier}': {
      get: {
        summary: 'Get a project by identifier',
        tags: ['Projects'],
        parameters: [
          { name: 'identifier', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Project details' } }
      },
      delete: {
        summary: 'Delete a project',
        tags: ['Projects'],
        parameters: [
          { name: 'identifier', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Project deleted' } }
      }
    },
    '/api/projects/{identifier}/archive': {
      post: {
        summary: 'Archive or unarchive a project',
        tags: ['Projects'],
        parameters: [
          { name: 'identifier', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  archived: { type: 'boolean' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Project archive status updated' } }
      }
    },
    '/api/projects/{project}/issues': {
      get: {
        summary: 'List issues in a project',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'priority', in: 'query', schema: { type: 'string' } },
          { name: 'label', in: 'query', schema: { type: 'string' } },
          { name: 'milestone', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Array of issues' } }
      },
      post: {
        summary: 'Create a new issue',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'] },
                  status: { type: 'string' },
                  labels: { type: 'array', items: { type: 'string' } },
                  type: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Created issue' } }
      }
    },
    '/api/projects/{project}/issues/{number}': {
      get: {
        summary: 'Get a specific issue',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'number', in: 'path', required: true, schema: { type: 'integer' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Issue details' } }
      }
    },
    '/api/issues/{issueId}': {
      patch: {
        summary: 'Update an issue',
        tags: ['Issues'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  priority: { type: 'string' },
                  status: { type: 'string' },
                  type: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Updated issue' } }
      },
      delete: {
        summary: 'Delete an issue',
        tags: ['Issues'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Issue deleted' } }
      }
    },
    '/api/issues/{issueId}/move': {
      post: {
        summary: 'Move an issue to a different project',
        tags: ['Issues'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetProject'],
                properties: { targetProject: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'Moved issue' } }
      }
    },
    '/api/issues/{issueId}/history': {
      get: {
        summary: 'Get issue activity history',
        tags: ['Issues'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Issue history' } }
      }
    },
    '/api/my-issues': {
      get: {
        summary: 'Get issues assigned to the authenticated user',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Array of assigned issues' } }
      }
    },
    '/api/projects/{project}/batch-issues': {
      post: {
        summary: 'Create multiple issues in batch',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['issues'],
                properties: {
                  issues: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['title'],
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        priority: { type: 'string' },
                        status: { type: 'string' },
                        labels: { type: 'array', items: { type: 'string' } },
                        type: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Batch creation result' } }
      }
    },
    '/api/projects/{project}/summary': {
      get: {
        summary: 'Get project summary with aggregated metrics',
        tags: ['Projects'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Project summary' } }
      }
    },
    '/api/projects/{project}/template': {
      post: {
        summary: 'Create issues from a template',
        tags: ['Issues'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['template'],
                properties: {
                  template: { type: 'string', enum: ['feature', 'bug', 'sprint', 'release'] },
                  title: { type: 'string' },
                  version: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Template creation result' } }
      }
    },
    '/api/labels': {
      get: {
        summary: 'List all labels',
        tags: ['Labels'],
        parameters: [{ $ref: '#/components/parameters/workspace' }],
        responses: { '200': { description: 'Array of labels' } }
      },
      post: {
        summary: 'Create a new label',
        tags: ['Labels'],
        parameters: [{ $ref: '#/components/parameters/workspace' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  color: { type: 'integer' }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Created label' } }
      }
    },
    '/api/issues/{issueId}/labels': {
      post: {
        summary: 'Add a label to an issue',
        tags: ['Labels'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { label: { type: 'string' } } } } }
        },
        responses: { '200': { description: 'Label added' } }
      }
    },
    '/api/issues/{issueId}/labels/{label}': {
      delete: {
        summary: 'Remove a label from an issue',
        tags: ['Labels'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'label', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Label removed' } }
      }
    },
    '/api/issues/{issueId}/relations': {
      post: { summary: 'Add a relation between issues', tags: ['Relations'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Relation added' } } }
    },
    '/api/issues/{issueId}/blocked-by': {
      post: { summary: 'Add a blocked-by dependency', tags: ['Relations'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Dependency added' } } }
    },
    '/api/issues/{issueId}/parent': {
      post: { summary: 'Set parent issue', tags: ['Relations'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Parent set' } } }
    },
    '/api/projects/{project}/task-types': {
      get: { summary: 'List task types for a project', tags: ['Metadata'], parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Array of task types' } } }
    },
    '/api/statuses': {
      get: { summary: 'List all issue statuses', tags: ['Metadata'], responses: { '200': { description: 'Array of statuses' } } }
    },
    '/api/projects/{project}/milestones': {
      get: { summary: 'List milestones', tags: ['Milestones'], parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Array of milestones' } } },
      post: { summary: 'Create a milestone', tags: ['Milestones'], parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created milestone' } } }
    },
    '/api/projects/{project}/milestones/{name}': {
      get: { summary: 'Get a milestone by name', tags: ['Milestones'], parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Milestone details' } } },
      patch: {
        summary: 'Update a milestone',
        tags: ['Milestones'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  status: { type: 'string' },
                  targetDate: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Milestone updated' } }
      },
      delete: {
        summary: 'Delete a milestone',
        tags: ['Milestones'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Milestone deleted' } }
      }
    },
    '/api/issues/{issueId}/milestone': {
      patch: { summary: 'Set or clear issue milestone', tags: ['Milestones'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Milestone set' } } }
    },
    '/api/issues/{issueId}/assignee': {
      patch: { summary: 'Assign or unassign an issue', tags: ['Members'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Assignee updated' } } }
    },
    '/api/members': {
      get: { summary: 'List workspace members', tags: ['Members'], responses: { '200': { description: 'Array of members' } } }
    },
    '/api/issues/{issueId}/comments': {
      get: { summary: 'List comments on an issue', tags: ['Comments'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Array of comments' } } },
      post: { summary: 'Add a comment to an issue', tags: ['Comments'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Comment added' } } }
    },
    '/api/issues/{issueId}/due-date': {
      patch: { summary: 'Set or clear due date', tags: ['Time Tracking'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Due date updated' } } }
    },
    '/api/issues/{issueId}/estimation': {
      patch: { summary: 'Set time estimation', tags: ['Time Tracking'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Estimation updated' } } }
    },
    '/api/issues/{issueId}/time-logs': {
      post: { summary: 'Log time on an issue', tags: ['Time Tracking'], parameters: [{ name: 'issueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Time logged' } } }
    },
    '/api/issues/{issueId}/time-reports': {
      get: {
        summary: 'List time reports for an issue',
        tags: ['Time Tracking'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Array of time reports' } }
      }
    },
    '/api/time-reports/{reportId}': {
      delete: {
        summary: 'Delete a time report',
        tags: ['Time Tracking'],
        parameters: [
          { name: 'reportId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Time report deleted' } }
      }
    },
    '/api/projects/{project}/components': {
      get: {
        summary: 'List components in a project',
        tags: ['Components'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Array of components' } }
      },
      post: {
        summary: 'Create a component',
        tags: ['Components'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'Created component' } }
      }
    },
    '/api/search': {
      get: {
        summary: 'Search issues by text',
        tags: ['Search'],
        parameters: [
          { name: 'query', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Search results' } }
      }
    },
    '/api/events': {
      get: {
        summary: 'SSE stream of issue change events',
        tags: ['Events'],
        responses: { '200': { description: 'Server-Sent Events stream' } }
      }
    },
    '/api/labels/{name}': {
      get: {
        summary: 'Get a label by name',
        tags: ['Labels'],
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Label details' } }
      }
    },
    '/api/members/{name}': {
      get: {
        summary: 'Get a member by name',
        tags: ['Members'],
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Member details' } }
      }
    },
    '/api/statuses/{name}': {
      get: {
        summary: 'Get a status by name',
        tags: ['Metadata'],
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Status details' } }
      }
    },
    '/api/projects/{project}/components/{name}': {
      get: {
        summary: 'Get a component by name',
        tags: ['Components'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Component details' } }
      },
      patch: {
        summary: 'Update a component',
        tags: ['Components'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Component updated' } }
      },
      delete: {
        summary: 'Delete a component',
        tags: ['Components'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Component deleted' } }
      }
    },
    '/api/projects/{project}/task-types/{name}': {
      get: {
        summary: 'Get a task type by name',
        tags: ['Metadata'],
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Task type details' } }
      }
    },
    '/api/issues/{issueId}/comments/{commentId}': {
      get: {
        summary: 'Get a specific comment',
        tags: ['Comments'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commentId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Comment details' } }
      },
      patch: {
        summary: 'Update a comment',
        tags: ['Comments'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commentId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'Comment updated' } }
      },
      delete: {
        summary: 'Delete a comment',
        tags: ['Comments'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commentId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Comment deleted' } }
      }
    },
    '/api/issues/{issueId}/time-reports/{reportId}': {
      get: {
        summary: 'Get a specific time report',
        tags: ['Time Tracking'],
        parameters: [
          { name: 'issueId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'reportId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/workspace' }
        ],
        responses: { '200': { description: 'Time report details' } }
      }
    }
  }
};

// ── Main Request Handler ──────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  // CORS headers for browser clients
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS === '*' && !API_TOKEN) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS !== '*') {
    const allowed = ALLOWED_ORIGINS.split(',').map(o => o.trim());
    if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Huly-Workspace, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check (no auth required)
  if (method === 'GET' && path === '/health') {
    return json(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  // OpenAPI spec (no auth required)
  if (method === 'GET' && path === '/api/openapi.json') {
    return json(res, 200, OPENAPI_SPEC);
  }

  // ── Auth check ──────────────────────────────────────────
  if (API_TOKEN) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token || Buffer.byteLength(token) !== Buffer.byteLength(API_TOKEN) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN))) {
      return json(res, 401, { error: 'Unauthorized. Provide a valid Bearer token in the Authorization header.' });
    }
  }

  // ── Rate limiting ───────────────────────────────────────
  const clientIP = req.socket.remoteAddress || 'unknown';
  const rateResult = checkRateLimit(clientIP);

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetAt / 1000));

  if (!rateResult.allowed) {
    return json(res, 429, {
      error: 'Rate limit exceeded',
      limit: RATE_LIMIT,
      retryAfterMs: rateResult.resetAt - Date.now()
    });
  }

  // ── SSE endpoint ────────────────────────────────────────
  if (method === 'GET' && path === '/api/events') {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return json(res, 503, { error: 'Too many SSE connections' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('event: connected\ndata: {"message":"Connected to Huly event stream"}\n\n');
    sseClients.add(res);
    const pingInterval = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(pingInterval); }
    }, 30000);
    req.on('close', () => { clearInterval(pingInterval); sseClients.delete(res); });
    return;
  }

    // ── Account-Level Routes (no workspace needed) ────────

    let params;

    if (method === 'GET' && path === '/api/workspaces') {
      return json(res, 200, await HulyClient.listWorkspaces(HULY_URL, HULY_CREDS));
    }

    if (method === 'GET' && (params = matchRoute('/api/workspaces/:slug/info', path))) {
      return json(res, 200, await HulyClient.getWorkspaceInfo(HULY_URL, HULY_CREDS, params.slug));
    }

    if (method === 'POST' && path === '/api/workspaces') {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      return json(res, 201, await HulyClient.createWorkspace(HULY_URL, HULY_CREDS, body.name));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/workspaces/:slug/name', path))) {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      return json(res, 200, await HulyClient.updateWorkspaceName(HULY_URL, HULY_CREDS, params.slug, body.name));
    }

    if (method === 'DELETE' && (params = matchRoute('/api/workspaces/:slug', path))) {
      return json(res, 200, await HulyClient.deleteWorkspace(HULY_URL, HULY_CREDS, params.slug));
    }

    if (method === 'GET' && (params = matchRoute('/api/workspaces/:slug/members', path))) {
      return json(res, 200, await HulyClient.getWorkspaceMembers(HULY_URL, HULY_CREDS, params.slug));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/workspaces/:slug/role', path))) {
      const body = await parseBody(req);
      if (!body.email || !body.role) return json(res, 400, { error: 'email and role are required' });
      return json(res, 200, await HulyClient.updateWorkspaceRole(HULY_URL, HULY_CREDS, params.slug, body.email, body.role));
    }

    if (method === 'GET' && path === '/api/account') {
      return json(res, 200, await HulyClient.getAccountInfo(HULY_URL, HULY_CREDS));
    }

    if (method === 'GET' && path === '/api/profile') {
      return json(res, 200, await HulyClient.getUserProfile(HULY_URL, HULY_CREDS));
    }

    if (method === 'PATCH' && path === '/api/profile') {
      const body = await parseBody(req);
      return json(res, 200, await HulyClient.setMyProfile(HULY_URL, HULY_CREDS, body.name, body.city, body.country));
    }

    if (method === 'POST' && (params = matchRoute('/api/workspaces/:slug/invites', path))) {
      const body = await parseBody(req);
      if (!body.email) return json(res, 400, { error: 'email is required' });
      return json(res, 200, await HulyClient.sendInvite(HULY_URL, HULY_CREDS, params.slug, body.email, body.role));
    }

    if (method === 'POST' && (params = matchRoute('/api/workspaces/:slug/invite-link', path))) {
      const body = await parseBody(req);
      return json(res, 200, await HulyClient.createInviteLink(HULY_URL, HULY_CREDS, params.slug, body.email, body.role, body.firstName, body.lastName, body.expireHours));
    }

    if (method === 'GET' && path === '/api/integrations') {
      return json(res, 200, await HulyClient.listIntegrations(HULY_URL, HULY_CREDS, {}));
    }

    if (method === 'POST' && path === '/api/integrations') {
      const body = await parseBody(req);
      return json(res, 201, await HulyClient.createIntegration(HULY_URL, HULY_CREDS, body));
    }

    if (method === 'DELETE' && (params = matchRoute('/api/integrations/:id', path))) {
      const body = await parseBody(req);
      return json(res, 200, await HulyClient.deleteIntegration(HULY_URL, HULY_CREDS, { socialId: body.socialId, kind: body.kind, workspaceUuid: body.workspaceUuid }));
    }

    if (method === 'GET' && path === '/api/mailboxes') {
      return json(res, 200, await HulyClient.getMailboxes(HULY_URL, HULY_CREDS));
    }

    if (method === 'GET' && path === '/api/social-ids') {
      return json(res, 200, await HulyClient.getSocialIds(HULY_URL, HULY_CREDS));
    }

    if (method === 'GET' && path === '/api/subscriptions') {
      return json(res, 200, await HulyClient.getSubscriptions(HULY_URL, HULY_CREDS));
    }

  const workspace = getWorkspace(req, url);

  try {
    const client = await pool.getClient(workspace);

    // ── Projects ──────────────────────────────────────────

    if (method === 'GET' && path === '/api/projects') {
      const include_details = url.searchParams.get('include_details') === 'true';
      return json(res, 200, await client.withReconnect(() => client.listProjects({ include_details })));
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:identifier', path))) {
      // Avoid matching other /api/projects/:something routes
      if (!['summary', 'milestones', 'issues', 'task-types', 'batch-issues', 'template', 'archive', 'components'].some(s => params.identifier === s)) {
        const include_details = url.searchParams.get('include_details') === 'true';
        return json(res, 200, await client.withReconnect(() => client.getProject(params.identifier, { include_details })));
      }
    }

    if (method === 'POST' && path === '/api/projects') {
      const body = await parseBody(req);
      if (!body.identifier) return json(res, 400, { error: 'identifier is required' });
      if (!body.name) return json(res, 400, { error: 'name is required' });
      const result = await client.withReconnect(() =>
        withSSE('project.created', () =>
          client.createProject(body.identifier, body.name, body.description, body.private, body.descriptionFormat, body.projectType)
        )
      );
      return json(res, 201, result);
    }

    if (method === 'PATCH' && (params = matchRoute('/api/projects/:identifier', path))) {
      const body = await parseBody(req);
      return json(res, 200, await client.withReconnect(() =>
        withSSE('project.updated', () =>
          client.updateProject(params.identifier, {
            name: body.name, description: body.description,
            isPrivate: body.private, defaultAssignee: body.defaultAssignee
          })
        )
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/projects/:identifier/archive', path))) {
      const body = await parseBody(req);
      const result = await client.withReconnect(() =>
        withSSE('project.archived', () =>
          client.archiveProject(params.identifier, body.archived)
        )
      );
      return json(res, 200, result);
    }

    if (method === 'DELETE' && (params = matchRoute('/api/projects/:identifier', path))) {
      if (!['summary', 'milestones', 'issues', 'task-types', 'batch-issues', 'template', 'archive', 'components'].some(s => params.identifier === s)) {
        const result = await client.withReconnect(() =>
          withSSE('project.deleted', () =>
            client.deleteProject(params.identifier)
          )
        );
        return json(res, 200, result);
      }
    }

    // ── Project Summary (Tier 2) ──────────────────────────

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/summary', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.summarizeProject(params.project)
      ));
    }

    // ── Issues ────────────────────────────────────────────

    if (method === 'GET' && path === '/api/my-issues') {
      const project = url.searchParams.get('project') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : undefined;
      return json(res, 200, await client.withReconnect(() =>
        client.getMyIssues(project, status, limit)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/issues', path))) {
      const status = url.searchParams.get('status') || undefined;
      const priority = url.searchParams.get('priority') || undefined;
      const label = url.searchParams.get('label') || undefined;
      const milestone = url.searchParams.get('milestone') || undefined;
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : undefined;
      const include_details = url.searchParams.get('include_details') === 'true';
      return json(res, 200, await client.withReconnect(() =>
        client.listIssues(params.project, status, priority, label, milestone, limit, include_details)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/issues/:number', path))) {
      const issueId = `${params.project}-${params.number}`;
      const include_details = url.searchParams.get('include_details') === 'true';
      return json(res, 200, await client.withReconnect(() => client.getIssue(issueId, { include_details })));
    }

    if (method === 'POST' && (params = matchRoute('/api/projects/:project/issues', path))) {
      const body = await parseBody(req);
      if (!body.title) return json(res, 400, { error: 'title is required' });
      const result = await client.withReconnect(() =>
        withSSE('issue.created', () =>
          client.createIssue(
            params.project, body.title, body.description,
            body.priority, body.status, body.labels, body.type,
            { assignee: body.assignee, component: body.component,
              milestone: body.milestone, dueDate: body.dueDate,
              estimation: body.estimation,
              descriptionFormat: body.descriptionFormat }
          )
        )
      );
      return json(res, 201, result);
    }

    if (method === 'POST' && (params = matchRoute('/api/projects/:project/batch-issues', path))) {
      const body = await parseBody(req);
      if (!body.issues || !Array.isArray(body.issues)) {
        return json(res, 400, { error: 'issues array is required' });
      }
      const result = await client.withReconnect(() =>
        withSSE('issues.batch_created', () =>
          client.batchCreateIssues(params.project, body.issues)
        )
      );
      return json(res, 201, result);
    }

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId', path))) {
      const body = await parseBody(req);
      const result = await client.withReconnect(() =>
        withSSE('issue.updated', () =>
          client.updateIssue(
            params.issueId, body.title, body.description,
            body.priority, body.status, body.type,
            { assignee: body.assignee, component: body.component,
              milestone: body.milestone, dueDate: body.dueDate,
              estimation: body.estimation,
              descriptionFormat: body.descriptionFormat }
          )
        )
      );
      return json(res, 200, result);
    }

    if (method === 'DELETE' && (params = matchRoute('/api/issues/:issueId', path))) {
      const result = await client.withReconnect(() =>
        withSSE('issue.deleted', () =>
          client.deleteIssue(params.issueId)
        )
      );
      return json(res, 200, result);
    }

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/move', path))) {
      const body = await parseBody(req);
      if (!body.targetProject) return json(res, 400, { error: 'targetProject is required' });
      const result = await client.withReconnect(() =>
        withSSE('issue.moved', () =>
          client.moveIssue(params.issueId, body.targetProject)
        )
      );
      return json(res, 200, result);
    }

    if (method === 'GET' && (params = matchRoute('/api/issues/:issueId/history', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getIssueHistory(params.issueId)
      ));
    }

    // ── Templates (Tier 2) ────────────────────────────────

    if (method === 'POST' && (params = matchRoute('/api/projects/:project/template', path))) {
      const body = await parseBody(req);
      if (!body.template) return json(res, 400, { error: 'template is required' });
      const result = await client.withReconnect(() =>
        withSSE('issues.template_created', () =>
          client.createIssuesFromTemplate(
            params.project, body.template, { title: body.title, version: body.version }
          )
        )
      );
      return json(res, 201, result);
    }

    // ── Labels ────────────────────────────────────────────

    if (method === 'GET' && path === '/api/labels') {
      return json(res, 200, await client.withReconnect(() => client.listLabels()));
    }

    if (method === 'POST' && path === '/api/labels') {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      return json(res, 201, await client.withReconnect(() =>
        client.createLabel(body.name, body.color)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/labels/:name', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getLabel(decodeURIComponent(params.name))
      ));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/labels/:name', path))) {
      const body = await parseBody(req);
      return json(res, 200, await client.withReconnect(() =>
        client.updateLabel(decodeURIComponent(params.name), {
          newName: body.newName, color: body.color, description: body.description
        })
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/labels', path))) {
      const body = await parseBody(req);
      if (!body.label) return json(res, 400, { error: 'label is required' });
      return json(res, 200, await client.withReconnect(() =>
        withSSE('issue.label_added', () =>
          client.addLabel(params.issueId, body.label)
        )
      ));
    }

    if (method === 'DELETE' && (params = matchRoute('/api/issues/:issueId/labels/:label', path))) {
      return json(res, 200, await client.withReconnect(() =>
        withSSE('issue.label_removed', () =>
          client.removeLabel(params.issueId, params.label)
        )
      ));
    }

    // ── Relations ─────────────────────────────────────────

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/relations', path))) {
      const body = await parseBody(req);
      if (!body.relatedToIssueId) return json(res, 400, { error: 'relatedToIssueId is required' });
      return json(res, 200, await client.withReconnect(() =>
        client.addRelation(params.issueId, body.relatedToIssueId)
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/blocked-by', path))) {
      const body = await parseBody(req);
      if (!body.blockedByIssueId) return json(res, 400, { error: 'blockedByIssueId is required' });
      return json(res, 200, await client.withReconnect(() =>
        client.addBlockedBy(params.issueId, body.blockedByIssueId)
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/parent', path))) {
      const body = await parseBody(req);
      if (!body.parentIssueId) return json(res, 400, { error: 'parentIssueId is required' });
      return json(res, 200, await client.withReconnect(() =>
        client.setParent(params.issueId, body.parentIssueId)
      ));
    }

    // ── Task Types & Statuses ─────────────────────────────

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/task-types', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.listTaskTypes(params.project)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/task-types/:name', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getTaskType(params.project, decodeURIComponent(params.name))
      ));
    }

    if (method === 'GET' && path === '/api/statuses') {
      const project = url.searchParams.get('project');
      const taskType = url.searchParams.get('taskType');
      return json(res, 200, await client.withReconnect(() => client.listStatuses(project, taskType)));
    }

    if (method === 'GET' && (params = matchRoute('/api/statuses/:name', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getStatus(decodeURIComponent(params.name))
      ));
    }

    // ── Milestones ────────────────────────────────────────

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/milestones', path))) {
      const status = url.searchParams.get('status') || undefined;
      const include_details = url.searchParams.get('include_details') === 'true';
      return json(res, 200, await client.withReconnect(() =>
        client.listMilestones(params.project, status, { include_details })
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/milestones/:name', path))) {
      const include_details = url.searchParams.get('include_details') === 'true';
      return json(res, 200, await client.withReconnect(() =>
        client.getMilestone(params.project, params.name, { include_details })
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/projects/:project/milestones', path))) {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      return json(res, 201, await client.withReconnect(() =>
        client.createMilestone(
          params.project, body.name, body.description,
          body.targetDate, body.status
        )
      ));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/projects/:project/milestones/:name', path))) {
      const body = await parseBody(req);
      const result = await client.withReconnect(() =>
        withSSE('milestone.updated', () =>
          client.updateMilestone(params.project, params.name, {
            name: body.name, description: body.description,
            status: body.status, targetDate: body.targetDate
          })
        )
      );
      return json(res, 200, result);
    }

    if (method === 'DELETE' && (params = matchRoute('/api/projects/:project/milestones/:name', path))) {
      const result = await client.withReconnect(() =>
        withSSE('milestone.deleted', () =>
          client.deleteMilestone(params.project, params.name)
        )
      );
      return json(res, 200, result);
    }

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId/milestone', path))) {
      const body = await parseBody(req);
      return json(res, 200, await client.withReconnect(() =>
        withSSE('issue.milestone_changed', () =>
          client.setMilestone(params.issueId, body.milestone)
        )
      ));
    }

    // ── Components ────────────────────────────────────────

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/components', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.listComponents(params.project)
      ));
    }

    if (method === 'POST' && (params = matchRoute('/api/projects/:project/components', path))) {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      const result = await client.withReconnect(() =>
        withSSE('component.created', () =>
          client.createComponent(params.project, body.name, body.description)
        )
      );
      return json(res, 201, result);
    }

    if (method === 'GET' && (params = matchRoute('/api/projects/:project/components/:name', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getComponent(params.project, decodeURIComponent(params.name))
      ));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/projects/:project/components/:name', path))) {
      const body = await parseBody(req);
      const result = await client.withReconnect(() =>
        withSSE('component.updated', () =>
          client.updateComponent(params.project, params.name, {
            name: body.name, description: body.description, lead: body.lead
          })
        )
      );
      return json(res, 200, result);
    }

    if (method === 'DELETE' && (params = matchRoute('/api/projects/:project/components/:name', path))) {
      const result = await client.withReconnect(() =>
        withSSE('component.deleted', () =>
          client.deleteComponent(params.project, params.name)
        )
      );
      return json(res, 200, result);
    }

    // ── Assignee ──────────────────────────────────────────

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId/assignee', path))) {
      const body = await parseBody(req);
      return json(res, 200, await client.withReconnect(() =>
        withSSE('issue.assigned', () =>
          client.assignIssue(params.issueId, body.assignee)
        )
      ));
    }

    // ── Members ───────────────────────────────────────────

    if (method === 'GET' && path === '/api/members') {
      return json(res, 200, await client.withReconnect(() => client.listMembers()));
    }

    if (method === 'GET' && (params = matchRoute('/api/members/:name', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getMember(decodeURIComponent(params.name))
      ));
    }

    // ── Comments ──────────────────────────────────────────

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/comments', path))) {
      const body = await parseBody(req);
      if (!body.text) return json(res, 400, { error: 'text is required' });
      return json(res, 201, await client.withReconnect(() =>
        withSSE('issue.comment_added', () =>
          client.addComment(params.issueId, body.text)
        )
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/issues/:issueId/comments', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.listComments(params.issueId)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/issues/:issueId/comments/:commentId', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getComment(params.issueId, params.commentId)
      ));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId/comments/:commentId', path))) {
      const body = await parseBody(req);
      if (!body.text) return json(res, 400, { error: 'text is required' });
      const result = await client.withReconnect(() =>
        withSSE('issue.comment_updated', () =>
          client.updateComment(params.issueId, params.commentId, body.text)
        )
      );
      return json(res, 200, result);
    }

    if (method === 'DELETE' && (params = matchRoute('/api/issues/:issueId/comments/:commentId', path))) {
      const result = await client.withReconnect(() =>
        withSSE('issue.comment_deleted', () =>
          client.deleteComment(params.issueId, params.commentId)
        )
      );
      return json(res, 200, result);
    }

    // ── Due Date & Estimation ─────────────────────────────

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId/due-date', path))) {
      const body = await parseBody(req);
      return json(res, 200, await client.withReconnect(() =>
        withSSE('issue.due_date_changed', () =>
          client.setDueDate(params.issueId, body.dueDate)
        )
      ));
    }

    if (method === 'PATCH' && (params = matchRoute('/api/issues/:issueId/estimation', path))) {
      const body = await parseBody(req);
      if (body.hours === undefined) return json(res, 400, { error: 'hours is required' });
      return json(res, 200, await client.withReconnect(() =>
        client.setEstimation(params.issueId, body.hours)
      ));
    }

    // ── Time Logs ─────────────────────────────────────────

    if (method === 'POST' && (params = matchRoute('/api/issues/:issueId/time-logs', path))) {
      const body = await parseBody(req);
      if (body.hours === undefined) return json(res, 400, { error: 'hours is required' });
      return json(res, 201, await client.withReconnect(() =>
        withSSE('issue.time_logged', () =>
          client.logTime(params.issueId, body.hours, body.description)
        )
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/issues/:issueId/time-reports', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.listTimeReports(params.issueId)
      ));
    }

    if (method === 'GET' && (params = matchRoute('/api/issues/:issueId/time-reports/:reportId', path))) {
      return json(res, 200, await client.withReconnect(() =>
        client.getTimeReport(params.issueId, params.reportId)
      ));
    }

    if (method === 'DELETE' && (params = matchRoute('/api/time-reports/:reportId', path))) {
      const result = await client.withReconnect(() =>
        withSSE('time_report.deleted', () =>
          client.deleteTimeReport(params.reportId)
        )
      );
      return json(res, 200, result);
    }

    // ── Search ────────────────────────────────────────────

    if (method === 'GET' && path === '/api/search') {
      const query = url.searchParams.get('query');
      if (!query) return json(res, 400, { error: 'query parameter is required' });
      const project = url.searchParams.get('project') || undefined;
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : undefined;
      return json(res, 200, await client.withReconnect(() =>
        client.searchIssues(query, project, limit)
      ));
    }

    // ── 404 ───────────────────────────────────────────────

    return json(res, 404, { error: `Not found: ${method} ${path}` });

  } catch (error) {
    const status = error.message?.includes('not found') ? 404
      : error.message?.includes('Invalid') ? 400
      : 500;
    const isDev = process.env.NODE_ENV === 'development';
    let message;
    if (isDev) {
      message = error.message;
    } else if (status === 404) {
      message = 'Resource not found';
    } else if (status === 400) {
      message = 'Invalid request';
    } else {
      message = 'Internal server error';
    }
    return json(res, status, { error: message });
  }
}

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Huly HTTP server v2.0.0 listening on port ${PORT}`);
  if (API_TOKEN) console.log('Bearer token authentication enabled');
  console.log(`Rate limit: ${RATE_LIMIT} requests/minute`);
  console.log(`OpenAPI spec: http://localhost:${PORT}/api/openapi.json`);
  console.log(`SSE events: http://localhost:${PORT}/api/events`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('SIGTERM received, shutting down...');
  setTimeout(() => process.exit(1), 10000).unref();
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();
  pool.clearAll();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.error('SIGINT received, shutting down...');
  setTimeout(() => process.exit(1), 10000).unref();
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();
  pool.clearAll();
  server.close(() => process.exit(0));
});
