/**
 * Password rules mirroring `validate_password_strength` and the field limits
 * in backend/app/schemas/user.py. The backend remains the source of truth.
 */
export interface PasswordRule {
  id: string;
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "length",
    label: `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
    test: (password) => password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH,
  },
  { id: "letter", label: "Contains a letter", test: (password) => /\p{L}/u.test(password) },
  { id: "other", label: "Contains a number or symbol", test: (password) => /[^\p{L}]/u.test(password) },
  { id: "variety", label: "At least 5 different characters", test: (password) => new Set(password).size >= 5 },
  {
    id: "whitespace",
    label: "No leading or trailing spaces",
    test: (password) => password.length > 0 && password.trim() === password,
  },
];

export function passwordMeetsRules(password: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(password));
}
