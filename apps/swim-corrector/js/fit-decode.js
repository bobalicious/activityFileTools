/* FIT decoder — dependency-free, browser + node.
 *
 * Preserves enough structure to re-encode byte-for-byte: the record stream is
 * kept in file order, values stay in raw (unscaled) integer form, and unknown
 * messages/fields survive untouched. Scaling belongs in the view layer.
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

  function DataView8(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function readField(dv, off, baseTypeByte, size, littleEndian) {
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
        case 'float32': v = dv.getFloat32(o, littleEndian); break;
        case 'float64': v = dv.getFloat64(o, littleEndian); break;
        case 'sint64': v = Number(dv.getBigInt64(o, littleEndian)); break;
        case 'uint64': case 'uint64z': v = Number(dv.getBigUint64(o, littleEndian)); break;
        default: v = dv.getUint8(o);
      }
      vals.push(v);
    }
    return count === 1 ? vals[0] : vals;
  }

  /* Returns:
   *   {
   *     header:  {headerSize, protocolVersion, profileVersion, dataSize, headerCrc},
   *     records: [ {kind:'definition'|'data', ...} ]  // file order preserved
   *     messages:[ {global, name, fields:{num->value}, devFields:[], _record} ]
   *     crc:     {stored, computed, valid}
   *   }
   */
  function decode(bytes) {
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
      throw new Error('FIT header declares ' + header.dataSize +
        ' bytes of data but the file only holds ' + (bytes.length - headerSize) + '.');
    }

    var pos = headerSize;
    var defs = {};          // localType -> definition
    var records = [];
    var messages = [];
    var lastTimestamp = null;

    while (pos < dataEnd) {
      var recStart = pos;
      var h = bytes[pos++];

      if (h & 0x80) {
        // Compressed-timestamp data message.
        var cLocal = (h >> 5) & 0x03;
        var offset = h & 0x1F;
        var cDef = defs[cLocal];
        if (!cDef) throw new Error('Data message references undefined local type ' + cLocal);
        if (lastTimestamp == null) throw new Error('Compressed timestamp before any absolute timestamp.');

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

        var fields = [];
        for (var f = 0; f < nFields; f++) {
          fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
          pos += 3;
        }

        var devFields = [];
        if (h & 0x20) {
          var nDev = bytes[pos++];
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
        if (!sDef) throw new Error('Data message references undefined local type ' + local);

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

    var storedCrc = bytes.length >= dataEnd + 2 ? (bytes[dataEnd] | (bytes[dataEnd + 1] << 8)) : null;
    var computedCrc = crcOver(bytes, 0, dataEnd);

    return {
      header: header,
      records: records,
      messages: messages,
      crc: { stored: storedCrc, computed: computedCrc, valid: storedCrc === computedCrc },
      trailingBytes: bytes.length - (dataEnd + 2) // chained FIT files would be > 0
    };

    function readDataMessage(def, buf, p, view) {
      var out = { global: def.global, name: def.name, fields: {}, devFields: [], def: def };
      for (var i = 0; i < def.fields.length; i++) {
        var fd = def.fields[i];
        out.fields[fd.num] = readField(view, p, fd.baseType, fd.size, def.littleEndian);
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

  function isFit(bytes) {
    return bytes.length >= 12 &&
           String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === '.FIT';
  }

  var api = {
    decode: decode,
    isFit: isFit,
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
