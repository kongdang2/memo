import * as F from 'fflate';
import {Buffer} from 'buffer/';
const u=b=>b instanceof Uint8Array?b:new Uint8Array(b);
export const inflateRawSync=b=>Buffer.from(F.inflateSync(u(b)));
export const inflateSync=b=>Buffer.from(F.unzlibSync(u(b)));
export const deflateSync=b=>Buffer.from(F.zlibSync(u(b)));
export const deflateRawSync=b=>Buffer.from(F.deflateSync(u(b)));
export const constants={};
export default {inflateRawSync,inflateSync,deflateSync,deflateRawSync,constants};
