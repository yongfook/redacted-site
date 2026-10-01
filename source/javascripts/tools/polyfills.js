// Small polyfills for older browsers. Import this file first.

// PDF.js reads page text with `for await (… of stream)`. Safari before 18.4
// cannot loop over a ReadableStream like this, and fails with "undefined is
// not a function". Add the loop support when it is missing.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
