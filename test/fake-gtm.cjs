#!/usr/bin/env node
// Offline protocol fixture. IDs are deliberately non-production placeholders.
const { createInterface } = require('node:readline');
const lineReader = createInterface({ input: process.stdin });
const tools = ['list_accounts', 'list_containers', 'list_workspaces', 'list_tags', 'list_triggers', 'list_variables', 'get_resource', 'publish_version'];
lineReader.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result;
  if (request.method === 'initialize') result = { serverInfo: { name: 'offline-fixture', version: '1' }, capabilities: {} };
  else if (request.method === 'tools/list') result = { tools: tools.map(name => ({ name })) };
  else {
    const name = request.params.name;
    const data = {
      list_accounts: { account: [{ name: 'Example account', accountId: 'example-account' }] },
      list_containers: { container: [{ publicId: 'GTM-EXAMPLE', name: 'Example container', containerId: 'example-container' }] },
      list_workspaces: { workspace: [{ name: 'Example workspace', workspaceId: 'example-workspace' }] },
      list_tags: { tag: [] }, list_triggers: { trigger: [] }, list_variables: { variable: [] }, get_resource: { tag: [] },
    };
    result = { content: [{ type: 'text', text: name === 'publish_version' ? '403 PERMISSION_DENIED' : JSON.stringify(data[name] || {}) }], isError: name === 'publish_version' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
