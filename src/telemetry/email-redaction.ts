/**
 * Email redaction shared by the telemetry sanitizers.
 */

const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const WORD_CHAR = /\w/;

function isWordBoundary(text: string, index: number): boolean {
  const before = index > 0 && WORD_CHAR.test(text[index - 1]);
  const after = index < text.length && WORD_CHAR.test(text[index]);
  return before !== after;
}

/**
 * SECURITY (GHSA-xvxq-x6hr-xc2c): replace email addresses with `placeholder`.
 * The local part starts at the first word boundary of the run before the `@`;
 * `domain` is a sticky (`y`) pattern matched right after the `@`.
 */
export function redactEmailAddresses(text: string, domain: RegExp, placeholder: string): string {
  let result = '';
  let copied = 0;
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at < copied) continue;
    let runStart = at;
    while (runStart > copied && EMAIL_LOCAL_CHAR.test(text[runStart - 1])) runStart--;
    let start = runStart;
    while (start < at && !isWordBoundary(text, start)) start++;
    if (start === at) continue;
    domain.lastIndex = at + 1;
    const domainMatch = domain.exec(text);
    if (!domainMatch) continue;
    result += `${text.substring(copied, start)}${placeholder}`;
    copied = at + 1 + domainMatch[0].length;
  }
  return copied === 0 ? text : result + text.substring(copied);
}
