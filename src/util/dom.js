/**
 * Creates a DOMException, with a plain Error fallback for environments without DOMException.
 * @param {string} message
 * @param {string} name
 */
export function domError(message, name) {
  if (typeof DOMException === "function") return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}
