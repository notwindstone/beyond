// tiny module to shortcut getting access to this boolean without loading the entire node:cluster module
import { process } from "beyond:process";
export default {
  isPrimary: !Object.prototype.hasOwnProperty.call(process.env, "NODE_UNIQUE_ID"),
};
