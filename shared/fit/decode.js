/* FIT decoder — dependency-free, browser + node. Shared by all three apps.
 *
 * Preserves enough structure to re-encode byte-for-byte: the record stream is
 * kept in file order, values stay in raw (unscaled) integer form, and unknown
 * messages/fields survive untouched. Scaling and semantics belong in the view
 * layer — see adapters.js.
 *
 * decode(bytes, options) where options are all opt-in and default to off:
 *
 *   nullifyInvalid  Map each base type's "no data" sentinel to null as it is
 *                   read. MUST stay off for anything that re-encodes: the
 *                   round-trip contract depends on sentinels surviving as
 *                   literal integers.
 *   tolerant        Stop cleanly at a malformed record rather than throwing,
 *                   clamp an over-declared dataSize, and seed a leading
 *                   compressed timestamp from 0 instead of rejecting it.
 *
 * With no options this behaves identically to the decoder it grew out of, so
 * the byte-faithful rewrite path is unaffected.
 */
(function (root) {
  'use strict';

  var FIT_EPOCH = 631065600; // Unix seconds at 1989-12-31T00:00:00Z

  var CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
                   0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];

  function crc16(crc, byte) {
    var tmp = CRC_TABLE[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[byte & 0xF];
    tmp = CRC_TABLE[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF];
    return crc & 0xFFFF;
  }

  function crcOver(bytes, start, end) {
    var crc = 0;
    for (var i = start; i < end; i++) crc = crc16(crc, bytes[i]);
    return crc;
  }

  // baseType byte -> {name, size, invalid}. Invalid is the sentinel meaning "no data".
  var BASE_TYPES = {
    0x00: { name: 'enum',    size: 1, invalid: 0xFF },
    0x01: { name: 'sint8',   size: 1, invalid: 0x7F },
    0x02: { name: 'uint8',   size: 1, invalid: 0xFF },
    0x83: { name: 'sint16',  size: 2, invalid: 0x7FFF },
    0x84: { name: 'uint16',  size: 2, invalid: 0xFFFF },
    0x85: { name: 'sint32',  size: 4, invalid: 0x7FFFFFFF },
    0x86: { name: 'uint32',  size: 4, invalid: 0xFFFFFFFF },
    0x07: { name: 'string',  size: 1, invalid: 0x00 },
    0x88: { name: 'float32', size: 4, invalid: null },
    0x89: { name: 'float64', size: 8, invalid: null },
    0x0A: { name: 'uint8z',  size: 1, invalid: 0x00 },
    0x8B: { name: 'uint16z', size: 2, invalid: 0x0000 },
    0x8C: { name: 'uint32z', size: 4, invalid: 0x00000000 },
    0x0D: { name: 'byte',    size: 1, invalid: 0xFF },
    0x8E: { name: 'sint64',  size: 8, invalid: null },
    0x8F: { name: 'uint64',  size: 8, invalid: null },
    0x90: { name: 'uint64z', size: 8, invalid: null }
  };

  function baseTypeOf(b) {
    return BASE_TYPES[b] || { name: 'byte', size: 1, invalid: 0xFF };
  }

  var MESG = {
    0: 'file_id', 18: 'session', 19: 'lap', 20: 'record', 21: 'event',
    23: 'device_info', 34: 'activity', 49: 'file_creator', 101: 'length',
    206: 'field_description', 207: 'developer_data_id'
  };

  /* Accept a Uint8Array, an ArrayBuffer or a Node Buffer. The apps read files
   * three different ways and shouldn't each need to know the difference. */
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    throw new Error('Expected a Uint8Array, ArrayBuffer or Buffer.');
  }

  function DataView8(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // float32's "invalid" is the 0xFFFFFFFF bit pattern, which is a NaN — so it
  // has to be spotted on the raw word before the float read.
  function isInvalidFloat32(dv, off, littleEndian) {
    return dv.getUint32(off, littleEndian) === 0xFFFFFFFF;
  }

  function readField(dv, off, baseTypeByte, size, littleEndian, nullifyInvalid) {
    var bt = baseTypeOf(baseTypeByte);

    if (bt.name === 'string') {
      // Fixed-width, NUL-padded. Keep the declared size so re-encoding matches.
      var s = '';
      for (var i = 0; i < size; i++) {
        var c = dv.getUint8(off + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }

    var count = Math.floor(size / bt.size);
    var vals = [];
    for (var j = 0; j < count; j++) {
      var o = off + j * bt.size;
      var v;
      switch (bt.name) {
        case 'enum': case 'uint8': case 'uint8z': case 'byte': v = dv.getUint8(o); break;
        case 'sint8':  v = dv.getInt8(o); break;
        case 'sint16': v = dv.getInt16(o, littleEndian); break;
        case 'uint16': case 'uint16z': v = dv.getUint16(o, littleEndian); break;
        case 'sint32': v = dv.getInt32(o, littleEndian); break;
        case 'uint32': case 'uint32z': v = dv.getUint32(o, littleEndian); break;
        case 'float32':
          v = (nullifyInvalid && isInvalidFloat32(dv, o, littleEndian))
            ? null : dv.getFloat32(o, littleEndian);
          break;
        case 'float64': v = dv.getFloat64(o, littleEndian); break;
        case 'sint64': v = Number(dv.getBigInt64(o, littleEndian)); break;
        case 'uint64': case 'uint64z': v = Number(dv.getBigUint64(o, littleEndian)); break;
        default: v = dv.getUint8(o);
      }
      if (nullifyInvalid && bt.invalid !== null && v === bt.invalid) v = null;
      vals.push(v);
    }
    return count === 1 ? vals[0] : vals;
  }

  /* Returns:
   *   {
   *     header:  {headerSize, protocolVersion, profileVersion, dataSize, headerCrc},
   *     records: [ {kind:'definition'|'data', ...} ]  // file order preserved
   *     messages:[ {global, name, fields:{num->value}, devFields:[], _record} ]
   *     byGlobal:{ globalNum -> [message] }           // index over messages
   *     crc:     {stored, computed, valid},
   *     trailingBytes: number                         // > 0 means a chained file
   *   }
   */
  function decode(input, options) {
    var opts = options || {};
    var nullifyInvalid = !!opts.nullifyInvalid;
    var tolerant = !!opts.tolerant;

    var bytes = toBytes(input);
    if (bytes.length < 14) throw new Error('Too short to be a FIT file.');

    var dv = DataView8(bytes);
    var headerSize = dv.getUint8(0);
    if (headerSize !== 12 && headerSize !== 14) {
      throw new Error('Unexpected FIT header size: ' + headerSize);
    }
    var sig = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (sig !== '.FIT') throw new Error('Not a FIT file (missing .FIT signature).');

    var header = {
      headerSize: headerSize,
      protocolVersion: dv.getUint8(1),
      profileVersion: dv.getUint16(2, true),
      dataSize: dv.getUint32(4, true),
      headerCrc: headerSize === 14 ? dv.getUint16(12, true) : null
    };

    var dataEnd = headerSize + header.dataSize;
    if (dataEnd > bytes.length) {
      if (!tolerant) {
        throw new Error('FIT header declares ' + header.dataSize +
          ' bytes of data but the file only holds ' + (bytes.length - headerSize) + '.');
      }
      dataEnd = bytes.length;
    }

    var pos = headerSize;
    var defs = {};          // localType -> definition
    var records = [];
    var messages = [];
    var lastTimestamp = null;
    var truncated = false;

    while (pos < dataEnd) {
      var recStart = pos;
      var h = bytes[pos++];

      if (h & 0x80) {
        // Compressed-timestamp data message.
        var cLocal = (h >> 5) & 0x03;
        var offset = h & 0x1F;
        var cDef = defs[cLocal];
        if (!cDef) {
          if (tolerant) { truncated = true; break; }
          throw new Error('Data message references undefined local type ' + cLocal);
        }
        if (lastTimestamp == null) {
          if (!tolerant) throw new Error('Compressed timestamp before any absolute timestamp.');
          lastTimestamp = 0;
        }
        if (tolerant && pos + defByteLength(cDef) > dataEnd) { truncated = true; break; }

        var ts = (lastTimestamp & ~0x1F) + offset;
        if (offset < (lastTimestamp & 0x1F)) ts += 0x20;
        lastTimestamp = ts;

        var cMsg = readDataMessage(cDef, bytes, pos, dv);
        pos = cMsg.pos;
        cMsg.message.compressedTimestamp = ts;
        cMsg.message.timeOffset = offset;

        var cRec = { kind: 'data', compressed: true, localType: cLocal, timeOffset: offset,
                     def: cDef, message: cMsg.message, byteStart: recStart };
        cMsg.message._record = cRec;
        records.push(cRec);
        messages.push(cMsg.message);

      } else if (h & 0x40) {
        // Definition message.
        var dLocal = h & 0x0F;
        var reserved = bytes[pos++];
        var arch = bytes[pos++];
        var le = arch === 0;
        var global = le ? dv.getUint16(pos, true) : dv.getUint16(pos, false);
        pos += 2;
        var nFields = bytes[pos++];
        if (tolerant && pos + nFields * 3 > dataEnd) { truncated = true; break; }

        var fields = [];
        for (var f = 0; f < nFields; f++) {
          fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
          pos += 3;
        }

        var devFields = [];
        if (h & 0x20) {
          var nDev = bytes[pos++];
          if (tolerant && pos + nDev * 3 > dataEnd) { truncated = true; break; }
          for (var d = 0; d < nDev; d++) {
            devFields.push({ num: bytes[pos], size: bytes[pos + 1], devDataIndex: bytes[pos + 2] });
            pos += 3;
          }
        }

        var def = {
          kind: 'definition', localType: dLocal, reserved: reserved, arch: arch,
          littleEndian: le, global: global, name: MESG[global] || ('global_' + global),
          fields: fields, devFields: devFields, hasDev: !!(h & 0x20), byteStart: recStart
        };
        defs[dLocal] = def;
        records.push(def);

      } else {
        // Standard data message.
        var local = h & 0x0F;
        var sDef = defs[local];
        if (!sDef) {
          if (tolerant) { truncated = true; break; }
          throw new Error('Data message references undefined local type ' + local);
        }
        if (tolerant && pos + defByteLength(sDef) > dataEnd) { truncated = true; break; }

        var sMsg = readDataMessage(sDef, bytes, pos, dv);
        pos = sMsg.pos;
        if (sMsg.message.fields[253] != null) lastTimestamp = sMsg.message.fields[253];

        var sRec = { kind: 'data', compressed: false, localType: local, def: sDef,
                     message: sMsg.message, byteStart: recStart };
        sMsg.message._record = sRec;
        records.push(sRec);
        messages.push(sMsg.message);
      }
    }

    var byGlobal = {};
    for (var m = 0; m < messages.length; m++) {
      var g = messages[m].global;
      (byGlobal[g] || (byGlobal[g] = [])).push(messages[m]);
    }

    var storedCrc = bytes.length >= dataEnd + 2 ? (bytes[dataEnd] | (bytes[dataEnd + 1] << 8)) : null;
    var computedCrc = crcOver(bytes, 0, dataEnd);

    return {
      header: header,
      records: records,
      messages: messages,
      byGlobal: byGlobal,
      crc: { stored: storedCrc, computed: computedCrc, valid: storedCrc === computedCrc },
      trailingBytes: bytes.length - (dataEnd + 2), // chained FIT files would be > 0
      truncated: truncated                          // tolerant mode stopped early
    };

    // Bytes a data message of this definition occupies, so tolerant mode can
    // tell a truncated tail from a decodable one before reading off the end.
    function defByteLength(def) {
      var n = 0, i;
      for (i = 0; i < def.fields.length; i++) n += def.fields[i].size;
      for (i = 0; i < def.devFields.length; i++) n += def.devFields[i].size;
      return n;
    }

    function readDataMessage(def, buf, p, view) {
      var out = { global: def.global, name: def.name, fields: {}, devFields: [], def: def };
      for (var i = 0; i < def.fields.length; i++) {
        var fd = def.fields[i];
        out.fields[fd.num] = readField(view, p, fd.baseType, fd.size, def.littleEndian, nullifyInvalid);
        p += fd.size;
      }
      for (var k = 0; k < def.devFields.length; k++) {
        var dfd = def.devFields[k];
        // Developer field types are declared out-of-band; keep raw bytes so they
        // survive a round-trip regardless of what they mean.
        out.devFields.push({
          num: dfd.num, devDataIndex: dfd.devDataIndex,
          raw: buf.slice(p, p + dfd.size)
        });
        p += dfd.size;
      }
      return { message: out, pos: p };
    }
  }

  function isFit(input) {
    var bytes;
    try { bytes = toBytes(input); } catch (e) { return false; }
    return bytes.length >= 12 &&
           String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === '.FIT';
  }

  var api = {
    decode: decode,
    isFit: isFit,
    toBytes: toBytes,
    crc16: crc16,
    crcOver: crcOver,
    baseTypeOf: baseTypeOf,
    BASE_TYPES: BASE_TYPES,
    MESG: MESG,
    FIT_EPOCH: FIT_EPOCH,
    fitToUnix: function (s) { return s + FIT_EPOCH; },
    unixToFit: function (s) { return s - FIT_EPOCH; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FitDecode = api;

})(typeof self !== 'undefined' ? self : this);
