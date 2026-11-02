/**
 * MCP resources: projects and issues addressable as huly:// URIs.
 */
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../pool.mjs';

/**
 * Register the resource template, list and read handlers on an MCP server.
 * @param {Object} server - MCP SDK Server
 */
export function registerResources(server) {
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'huly://projects/{identifier}',
          name: 'Huly Project',
          description: 'A project in the Huly workspace',
          mimeType: 'application/json'
        },
        {
          uriTemplate: 'huly://issues/{issueId}',
          name: 'Huly Issue',
          description: 'An issue in the Huly workspace (e.g., huly://issues/PROJ-42)',
          mimeType: 'application/json'
        }
      ]
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const client = await pool.getClient();
      const result = await client.withReconnect(() => client.listProjects());
      return {
        resources: result.items.map(p => ({
          uri: `huly://projects/${p.identifier}`,
          name: `${p.identifier}: ${p.name}`,
          description: `Project with ${p.issueCount} issues`,
          mimeType: 'application/json'
        }))
      };
    } catch (e) {
      console.error('ListResources failed:', e.message);
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    // Match huly://projects/{identifier}
    const projectMatch = uri.match(/^huly:\/\/projects\/([A-Z0-9]+)$/i);
    if (projectMatch) {
      const client = await pool.getClient();
      const result = await client.withReconnect(() =>
        client.getProject(projectMatch[1])
      );
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }

    // Match huly://issues/{issueId}
    const issueMatch = uri.match(/^huly:\/\/issues\/([A-Z0-9]+-\d+)$/i);
    if (issueMatch) {
      const client = await pool.getClient();
      const result = await client.withReconnect(() =>
        client.getIssue(issueMatch[1])
      );
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });
}
