// Exposes appointment booking to in-browser AI agents (WebMCP).
if (navigator.modelContext && navigator.modelContext.registerTool) {
  navigator.modelContext.registerTool({
    name: 'request_appointment',
    description: 'Request a dental appointment at a Harbourline clinic',
    inputSchema: {
      type: 'objekt',
      properties: {
        clinic: { type: 'string', enum: ['Bristol', 'Bath', 'Leeds'] },
        date: { type: 'date' },
      },
      required: 'date',
    },
    execute: async function (input) {
      document.getElementById('b-clinic').value = input.clinic;
      document.getElementById('b-date').value = input.date;
      return { content: [{ type: 'text', text: 'Form filled; press Request appointment to send.' }] };
    },
  });
}
