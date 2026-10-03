// The scan light: a band of light that sweeps over the file and the AI bar
// while the tool looks at the file (CSS: .is-scanning). Every tool that takes
// a file uses it, so users see the same thing in each tool.
//
//   const scanning = scanLight(stage, modelBar);
//   scanning(true);       // start
//   scanning(false);      // stop, after at least MIN_MS so a fast scan does not flicker
//   scanning(false, true) // stop at once (the user closed the file)

const MIN_MS = 800;

export function scanLight(...elements) {
  let on = false;
  let start = 0;
  let timer = 0;
  const set = (value) => elements.forEach((el) => el && el.classList.toggle("is-scanning", value));
  return (next, now = false) => {
    clearTimeout(timer);
    if (next) {
      if (!on) start = performance.now();
      on = true;
      set(true);
    } else {
      on = false;
      const wait = now ? 0 : Math.max(0, MIN_MS - (performance.now() - start));
      if (wait) timer = setTimeout(() => set(false), wait);
      else set(false);
    }
  };
}
