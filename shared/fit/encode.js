/* FIT encoder — dependency-free, browser + node. Shared by all three apps.
 *
 * Two jobs, deliberately kept separate:
 *
 *   encode(decoded)          Rewrites a file decoded by decode.js. The contract
 *                            is encode(decode(bytes)) === bytes, byte for byte,
 *                            so anything the app doesn't understand is
 *                            reproduced rather than dropped.
 *
 *   ByteSink / writeField /  The primitives for building a file from scratch,
 *   writeDefinition /        used by apps that synthesise an activity rather
 *   assembleFile             than edit an existing one.
 *
 * They are not the same operation and don't collapse into one: a rewrite is
 * driven by the definitions already in the file, a synthesis declares its own.
 * What they share is everything below the message layer, which lives here once.
 */
(function (root) {
  'use strict';

  var D = (typeof module !== 'undefined' && module.exports)
    ? require('./decode.js')
    : root.FitDecode;

  function ByteSink() {
    this.chunks = [];
    this.length = 0;
  }
  ByteSink.prototype.u8 = function (v) {
    this.chunks.push(v & 0xFF);
    this.length += 1;
  };
  ByteSink.prototype.bytes = function (arr) {
    for (var i = 0; i < arr.length; i++) this.chunks.push(arr[i] & 0xFF);
    this.length += arr.length;
  };
  ByteSink.prototype.toUint8Array = function () {
    return new Uint8Array(this.chunks);
  };

  /* Writes one field's bytes. A null value becomes that base type's "invalid"
   * sentinel, which is how FIT says "no data recorded" — so callers can pass
   * null for an optional reading and get a conformant file. */
  function writeField(sink, value, baseTypeByte, size, littleEndian) {
    var bt = D.baseTypeOf(baseTypeByte);
    var buf = new Uint8Array(size);
    var dv = new DataView(buf.buffer);

    if (bt.name === 'string') {
      // NUL-pad to the declared width; truncate rather than overflow the field.
      for (var i = 0; i < size; i++) {
        buf[i] = i < value.length ? (value.charCodeAt(i) & 0xFF) : 0;
      }
      if (value.length >= size) buf[size - 1] = 0; // always NUL-terminated
      sink.bytes(buf);
      return;
    }

    var count = Math.floor(size / bt.size);
    var vals = Array.isArray(value) ? value : [value];

    for (var j = 0; j < count; j++) {
      var o = j * bt.size;
      var v = vals[j];
      if (v == null) v = bt.invalid == null ? 0 : bt.invalid;
      switch (bt.name) {
        case 'enum': case 'uint8': case 'uint8z': case 'byte': dv.setUint8(o, v & 0xFF); break;
        case 'sint8':  dv.setInt8(o, v); break;
        case 'sint16': dv.setInt16(o, v, littleEndian); break;
        case 'uint16': case 'uint16z': dv.setUint16(o, v & 0xFFFF, littleEndian); break;
        case 'sint32': dv.setInt32(o, v | 0, littleEndian); break;
        case 'uint32': case 'uint32z': dv.setUint32(o, v >>> 0, littleEndian); break;
        case 'float32': dv.setFloat32(o, v, littleEndian); break;
        case 'float64': dv.setFloat64(o, v, littleEndian); break;
        case 'sint64': dv.setBigInt64(o, BigInt(Math.round(v)), littleEndian); break;
        case 'uint64': case 'uint64z': dv.setBigUint64(o, BigInt(Math.round(v)), littleEndian); break;
        default: dv.setUint8(o, v & 0xFF);
      }
    }
    sink.bytes(buf);
  }

  /* Writes a definition message. `def` matches the shape decode.js produces, so
   * the same function serves both a rewrite and a synthesis: {localType, global,
   * fields:[{num,size,baseType}], devFields?, littleEndian?, reserved?, arch?}. */
  function writeDefinition(sink, def) {
    var littleEndian = def.littleEndian !== false;
    var hasDev = !!(def.hasDev && def.devFields && def.devFields.length);

    var h = 0x40 | (def.localType & 0x0F);
    if (hasDev) h |= 0x20;
    sink.u8(h);
    sink.u8(def.reserved || 0);
    sink.u8(def.arch != null ? def.arch : (littleEndian ? 0 : 1));

    var g = new Uint8Array(2);
    new DataView(g.buffer).setUint16(0, def.global, littleEndian);
    sink.bytes(g);

    sink.u8(def.fields.length);
    for (var i = 0; i < def.fields.length; i++) {
      sink.u8(def.fields[i].num);
      sink.u8(def.fields[i].size);
      sink.u8(def.fields[i].baseType);
    }
    if (hasDev) {
      sink.u8(def.devFields.length);
      for (var d = 0; d < def.devFields.length; d++) {
        sink.u8(def.devFields[d].num);
        sink.u8(def.devFields[d].size);
        sink.u8(def.devFields[d].devDataIndex);
      }
    }
  }

  /* Writes a data message for `def`, taking each field's value from `values`
   * keyed by field number. Missing or null entries become invalid sentinels. */
  function writeDataMessage(sink, def, values) {
    var littleEndian = def.littleEndian !== false;
    sink.u8(def.localType & 0x0F);
    for (var i = 0; i < def.fields.length; i++) {
      var f = def.fields[i];
      writeField(sink, values[f.num], f.baseType, f.size, littleEndian);
    }
  }

  /* Wraps a data section in a FIT header and CRC. dataSize and both CRCs are
   * computed here, so a caller that changed message sizes still gets a valid
   * file. */
  function assembleFile(data, header) {
    var h = header || {};
    var headerSize = h.headerSize != null ? h.headerSize : 14;
    var out = new Uint8Array(headerSize + data.length + 2);
    var dv = new DataView(out.buffer);

    dv.setUint8(0, headerSize);
    dv.setUint8(1, h.protocolVersion != null ? h.protocolVersion : 0x20);
    dv.setUint16(2, h.profileVersion != null ? h.profileVersion : 2140, true);
    dv.setUint32(4, data.length, true);
    out[8] = 0x2E; out[9] = 0x46; out[10] = 0x49; out[11] = 0x54; // ".FIT"

    if (headerSize === 14) {
      dv.setUint16(12, D.crcOver(out, 0, 12), true);
    }

    out.set(data, headerSize);

    var fileCrc = D.crcOver(out, 0, headerSize + data.length);
    dv.setUint16(headerSize + data.length, fileCrc, true);

    return out;
  }

  // ---- rewriting a decoded file ------------------------------------------

  function encodeDataSection(records) {
    var sink = new ByteSink();

    for (var r = 0; r < records.length; r++) {
      var rec = records[r];

      if (rec.kind === 'definition') {
        writeDefinition(sink, rec);

      } else {
        var def = rec.def;
        if (rec.compressed) {
          sink.u8(0x80 | ((rec.localType & 0x03) << 5) | (rec.timeOffset & 0x1F));
        } else {
          sink.u8(rec.localType & 0x0F);
        }

        var msg = rec.message;
        for (var f = 0; f < def.fields.length; f++) {
          var fd = def.fields[f];
          writeField(sink, msg.fields[fd.num], fd.baseType, fd.size, def.littleEndian);
        }
        for (var k = 0; k < def.devFields.length; k++) {
          // Round-tripped verbatim — we never claim to understand these.
          sink.bytes(msg.devFields[k].raw);
        }
      }
    }

    return sink.toUint8Array();
  }

  function encode(decoded) {
    return assembleFile(encodeDataSection(decoded.records), decoded.header);
  }

  var api = {
    encode: encode,
    encodeDataSection: encodeDataSection,
    ByteSink: ByteSink,
    writeField: writeField,
    writeDefinition: writeDefinition,
    writeDataMessage: writeDataMessage,
    assembleFile: assembleFile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FitEncode = api;

})(typeof self !== 'undefined' ? self : this);
