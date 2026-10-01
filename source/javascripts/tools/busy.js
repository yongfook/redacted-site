// Show that a button is working: a spinner, a short label with progress,
// and no more clicks until the work ends.

export function busy(button, label) {
  if (!button.classList.contains("is-busy")) {
    button.dataset.label = button.textContent;
    // Keep the width, so the row does not move while the label changes.
    button.style.minWidth = `${button.offsetWidth}px`;
    button.classList.add("is-busy");
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  }
  button.textContent = label;
}

export function idle(button) {
  if (!button.classList.contains("is-busy")) return;
  button.textContent = button.dataset.label;
  button.style.minWidth = "";
  button.classList.remove("is-busy");
  button.removeAttribute("aria-busy");
  button.disabled = false;
}

// A short message under the download button, such as "Done" or an error.
export function note(el, text = "", kind = "") {
  el.textContent = text;
  el.dataset.kind = kind;
}

// The name of a downloaded file: the site name first, so people can see
// where the file came from.
export const downloadName = (name) => `www.redacted.to--${name}`;
