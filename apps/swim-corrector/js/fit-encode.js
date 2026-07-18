/* FIT encoder — writes back a structure produced by FitDecode.decode().
 *
 * The contract: encode(decode(bytes)) === bytes, byte for byte. Everything the
 * app changes goes through the decoded structure first, so anything it doesn't
 * understand is reproduced rather than dropped.
 */
(function (root) {
  'use strict';

  var D = (typeof module !== 'undefined' && module.exports)
    ? require('../../../shared/fit/decode.js')
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

  function encodeDataSection(records) {
    var sink = new ByteSink();

    for (var r = 0; r < records.length; r++) {
      var rec = records[r];

      if (rec.kind === 'definition') {
        var h = 0x40 | (rec.localType & 0x0F);
        if (rec.hasDev) h |= 0x20;
        sink.u8(h);
        sink.u8(rec.reserved || 0);
        sink.u8(rec.arch);

        var g = new Uint8Array(2);
        new DataView(g.buffer).setUint16(0, rec.global, rec.littleEndian);
        sink.bytes(g);

        sink.u8(rec.fields.length);
        for (var i = 0; i < rec.fields.length; i++) {
          sink.u8(rec.fields[i].num);
          sink.u8(rec.fields[i].size);
          sink.u8(rec.fields[i].baseType);
        }
        if (rec.hasDev) {
          sink.u8(rec.devFields.length);
          for (var d = 0; d < rec.devFields.length; d++) {
            sink.u8(rec.devFields[d].num);
            sink.u8(rec.devFields[d].size);
            sink.u8(rec.devFields[d].devDataIndex);
          }
        }

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

  /* Rebuilds a complete FIT file (header + data + CRC) from a decoded structure.
   * The header's dataSize and both CRCs are recomputed, so edits that change
   * message sizes stay valid. */
  function encode(decoded) {
    var data = encodeDataSection(decoded.records);
    var headerSize = decoded.header.headerSize;
    var out = new Uint8Array(headerSize + data.length + 2);
    var dv = new DataView(out.buffer);

    dv.setUint8(0, headerSize);
    dv.setUint8(1, decoded.header.protocolVersion);
    dv.setUint16(2, decoded.header.profileVersion, true);
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

  var api = { encode: encode, encodeDataSection: encodeDataSection };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FitEncode = api;

})(typeof self !== 'undefined' ? self : this);
