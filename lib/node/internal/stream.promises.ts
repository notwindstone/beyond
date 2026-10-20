"use strict";

const ArrayPrototypePop = Array.prototype.pop;

import { isIterable, isNodeStream, isWebStream } from "node:internal/streams/utils";
import { pipelineImpl as pl } from "node:internal/streams/pipeline";
import { finished } from "node:internal/streams/end-of-stream";

// require("internal/stream");

function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    let signal;
    let end;
    const lastArg = streams[streams.length - 1];
    if (
      lastArg &&
      typeof lastArg === "object" &&
      !isNodeStream(lastArg) &&
      !isIterable(lastArg) &&
      !isWebStream(lastArg)
    ) {
      const options = ArrayPrototypePop.call(streams);
      signal = options.signal;
      end = options.end;
    }

    pl(
      streams,
      (err, value) => {
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      },
      { signal, end },
    );
  });
}

export default {
  finished,
  pipeline,
};

export { finished, pipeline };
