// brand.ts - the product name, and the assistant's name and how it addresses the user.

/** The product name. The assistant uses it too unless the user gives it another name. */
export const NAME = 'Cortana';

/** The assistant's name: the one the user chose, or the product name. */
export function assistantName(chosen: string | undefined): string {
  return chosen?.trim() || NAME;
}
