/** Event the library dispatches on a stable stream after it swapped the stream's track. */
export const TRACK_SWAPPED = "realtic-trackswapped";

/**
 * Plays a stable stream in a media element and keeps it playing across track swaps. Chromium
 * renders a track added to a playing `srcObject` at once; Firefox does not render it until
 * `srcObject` is assigned again, which this helper does on every swap. Returns a function that
 * detaches the helper.
 * @param {HTMLMediaElement} element
 * @param {MediaStream} stream
 */
export function attachMedia(element, stream) {
  const reassign = () => {
    element.srcObject = null;
    element.srcObject = stream;
    element.play?.().catch(() => {});
  };
  element.srcObject = stream;
  element.play?.().catch(() => {});
  stream.addEventListener?.(TRACK_SWAPPED, reassign);
  return () => stream.removeEventListener?.(TRACK_SWAPPED, reassign);
}
