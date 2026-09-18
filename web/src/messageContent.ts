export function displayMessageContent(content: string) {
  return content.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n');
}
