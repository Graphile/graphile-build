// @flow
import debugFactory from "debug";

const debugWarn = debugFactory("graphile-build:warn");

export default function swallowError(e: Error): void {
  // XXX: Improve this
  if (!debugWarn.enabled) {
    // eslint-disable-next-line no-console
    console.warn(
      `An error occurred, it might be okay but it doesn't look like the error we were expecting... run with envvar 'DEBUG="graphile-build:warn"' to view the error`
    );
  }
  debugWarn(e);
}
