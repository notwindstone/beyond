// Hardcoded module "node:inspector/promises"
import inspector from "node:inspector";

const { Session: BaseSession, console, open, close, url, waitForDebugger } = inspector;

// Promise-based Session that wraps the callback-based Session
class Session extends BaseSession {
  post(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      super.post(method, params, (err: Error | null, result: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }
}

export default {
  console,
  open,
  close,
  url,
  waitForDebugger,
  Session,
};

export { console, open, close, url, waitForDebugger, Session };
