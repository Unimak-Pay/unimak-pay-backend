/** "Aminata Kamara" → "A*** K***" */
export function maskName(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}***`)
    .join(' ');
}

/** "+23276123456" → "+232*****456" */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return phone.slice(0, 4) + '*'.repeat(phone.length - 7) + phone.slice(-3);
}

/** "Aminata Kamara" → "Aminata K.", "Mohamed Lamin Bangura" → "Mohamed B.", "Aminata" → "Aminata" (USSD screens) */
export function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]!;
  return parts.length === 1 ? first : `${first} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}
