export function buildLarkCliGuidance(): string {
  return [
    '## Feishu / Lark CLI',
    'This host provides `lark-cli` for real Feishu/Lark operations.',
    'Use it for docs, wiki, drive files, calendar events, tasks, IM, and Base operations when the user asks.',
    'Start with `lark-cli doctor` when credentials or permissions are uncertain.',
    'Use `lark-cli docs --help`, `lark-cli calendar --help`, and `lark-cli task --help` for exact workflows.',
    'Do not simulate Feishu success; run the CLI or report the exact CLI/API error.',
  ].join('\n');
}
