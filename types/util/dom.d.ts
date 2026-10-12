/**
 * Creates a DOMException, with a plain Error fallback for environments without DOMException.
 * @param {string} message
 * @param {string} name
 */
export function domError(message: string, name: string): DOMException | Error;
