package providers

// Hand-written protobuf wire-format codec for the Cursor port.
//
// There is no .proto file in the tree — Cursor does not publish one — so the
// field numbers below were recovered from the Node encoder/decoder pair
// (open-sse/utils/cursorProtobuf.js) and the executor's request builder
// (open-sse/executors/cursor.js). Everything is varint / length-delimited; no
// fixed64 appears in the request path and the only fixed64 is
// google.protobuf.Value's number arm on the response side.
//
// This file deliberately implements the wire format rather than generating from
// a schema: the vendor does not ship one, and a hand-rolled codec here is ~300
// lines against a protoc + plugin toolchain the Go build does not have (zero
// cgo, no protoc in the image).

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Protobuf wire types.
const (
	pbVarint  = 0
	pbFixed64 = 1
	pbLen     = 2
	pbFixed32 = 5
)

// pbWriter accumulates an encoded message.
type pbWriter struct {
	buf []byte
}

func (w *pbWriter) bytes() []byte { return w.buf }

// varint appends a base-128 varint.
func (w *pbWriter) varint(v uint64) {
	for v >= 0x80 {
		w.buf = append(w.buf, byte(v)|0x80)
		v >>= 7
	}
	w.buf = append(w.buf, byte(v))
}

// tag writes a field tag: (fieldNumber << 3) | wireType.
func (w *pbWriter) tag(field int, wireType int) {
	w.varint(uint64(field)<<3 | uint64(wireType))
}

// fieldVarint writes an integer field.
func (w *pbWriter) fieldVarint(field int, value uint64) {
	w.tag(field, pbVarint)
	w.varint(value)
}

// fieldBytes writes a length-delimited field. An empty value still emits the
// tag and a zero length: several Cursor fields are "present but empty" and carry
// meaning that way (the empty ConversationStateStructure opening a fresh agent
// session, for one).
func (w *pbWriter) fieldBytes(field int, value []byte) {
	w.tag(field, pbLen)
	w.varint(uint64(len(value)))
	w.buf = append(w.buf, value...)
}

// fieldString writes a length-delimited string field.
func (w *pbWriter) fieldString(field int, value string) {
	w.tag(field, pbLen)
	w.varint(uint64(len(value)))
	w.buf = append(w.buf, value...)
}

// fieldMessage writes a nested message field.
func (w *pbWriter) fieldMessage(field int, msg *pbWriter) {
	w.fieldBytes(field, msg.bytes())
}

// fieldDouble writes a fixed64 field (google.protobuf.Value's number arm).
func (w *pbWriter) fieldDouble(field int, value float64) {
	w.tag(field, pbFixed64)
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], math.Float64bits(value))
	w.buf = append(w.buf, b[:]...)
}

// pbField is one decoded field: its wire type and raw value.
//
// A repeated field appears as several pbField entries under one number, which is
// why the reader returns slices rather than a map.
type pbField struct {
	Wire   int
	Varint uint64
	Bytes  []byte
}

// pbReader walks an encoded message.
type pbReader struct {
	buf []byte
	pos int
}

func newPBReader(b []byte) *pbReader { return &pbReader{buf: b} }

func (r *pbReader) done() bool { return r.pos >= len(r.buf) }

// readVarint decodes a base-128 varint.
func (r *pbReader) readVarint() (uint64, error) {
	var result uint64
	var shift uint
	for {
		if r.pos >= len(r.buf) {
			return 0, errors.New("cursor pb: varint ran past the end of the message")
		}
		b := r.buf[r.pos]
		r.pos++
		if shift >= 64 {
			return 0, errors.New("cursor pb: varint is longer than 64 bits")
		}
		result |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return result, nil
		}
		shift += 7
	}
}

// readField decodes the next field.
func (r *pbReader) readField() (int, pbField, error) {
	tag, err := r.readVarint()
	if err != nil {
		return 0, pbField{}, err
	}
	number := int(tag >> 3)
	wire := int(tag & 0x07)

	switch wire {
	case pbVarint:
		v, err := r.readVarint()
		if err != nil {
			return 0, pbField{}, err
		}
		return number, pbField{Wire: wire, Varint: v}, nil
	case pbLen:
		length, err := r.readVarint()
		if err != nil {
			return 0, pbField{}, err
		}
		if r.pos+int(length) > len(r.buf) {
			return 0, pbField{}, fmt.Errorf("cursor pb: field %d claims %d bytes but only %d remain", number, length, len(r.buf)-r.pos)
		}
		value := r.buf[r.pos : r.pos+int(length)]
		r.pos += int(length)
		return number, pbField{Wire: wire, Bytes: value}, nil
	case pbFixed64:
		if r.pos+8 > len(r.buf) {
			return 0, pbField{}, errors.New("cursor pb: fixed64 ran past the end of the message")
		}
		value := r.buf[r.pos : r.pos+8]
		r.pos += 8
		return number, pbField{Wire: wire, Bytes: value}, nil
	case pbFixed32:
		if r.pos+4 > len(r.buf) {
			return 0, pbField{}, errors.New("cursor pb: fixed32 ran past the end of the message")
		}
		value := r.buf[r.pos : r.pos+4]
		r.pos += 4
		return number, pbField{Wire: wire, Bytes: value}, nil
	}
	return 0, pbField{}, fmt.Errorf("cursor pb: unsupported wire type %d on field %d", wire, number)
}

// pbMessage decodes a whole message into field-number → occurrences. Field order
// is preserved within each number, which the tool-call accumulator depends on.
func pbMessage(b []byte) (map[int][]pbField, error) {
	out := map[int][]pbField{}
	r := newPBReader(b)
	for !r.done() {
		number, field, err := r.readField()
		if err != nil {
			return nil, err
		}
		out[number] = append(out[number], field)
	}
	return out, nil
}

// firstBytes returns the first length-delimited value for a field, or nil.
func pbFirstBytes(fields map[int][]pbField, number int) []byte {
	values := fields[number]
	if len(values) == 0 {
		return nil
	}
	return values[0].Bytes
}

// firstVarint returns the first varint for a field, or 0.
func pbFirstVarint(fields map[int][]pbField, number int) uint64 {
	values := fields[number]
	if len(values) == 0 {
		return 0
	}
	return values[0].Varint
}

// pbFirstString returns the first length-delimited value as a string.
func pbFirstString(fields map[int][]pbField, number int) string {
	return string(pbFirstBytes(fields, number))
}

// pbHas reports whether a field is present at all. Presence matters: Cursor
// distinguishes "absent" from "present and zero" on several fields.
func pbHas(fields map[int][]pbField, number int) bool {
	return len(fields[number]) > 0
}

// ── ConnectRPC framing ───────────────────────────────────────────────────────

// ConnectRPC frame flags. Bit 0 is gzip, bit 1 is an end-of-stream trailer.
const (
	connectFlagNone        = 0x00
	connectFlagGzip        = 0x01
	connectFlagTrailer     = 0x02
	connectFlagGzipTrailer = 0x03
)

// connectFrame wraps a payload as [flags u8][length u32 BE][payload]. Cursor's
// request side never compresses, but the frame layout is shared with responses.
func connectFrame(payload []byte) []byte {
	frame := make([]byte, 5+len(payload))
	frame[0] = connectFlagNone
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame
}

// connectUnframe extracts one frame from the front of buf.
//
// Returns the payload, the consumed byte count, and whether a complete frame was
// available. An incomplete frame returns ok=false so the caller can buffer and
// retry rather than treating a split frame as corruption.
func connectUnframe(buf []byte) (payload []byte, consumed int, ok bool) {
	if len(buf) < 5 {
		return nil, 0, false
	}
	length := int(binary.BigEndian.Uint32(buf[1:5]))
	// A declared length above the cap is a poisoned stream, not a frame still in
	// flight. Without this check the decoder buffers forever waiting on a frame
	// that will never complete — the same silent stall that hung the Kiro
	// stream, where reads returned no bytes and no error.
	if length > cursorFrameMaxPayload {
		return nil, 0, false
	}
	if len(buf) < 5+length {
		return nil, 0, false
	}
	return buf[5 : 5+length], 5 + length, true
}

// ── google.protobuf.Value ────────────────────────────────────────────────────
//
// agent.v1.McpToolDefinition carries its JSON schema as a protobuf Value, so the
// tool schema has to round-trip through this representation. The arms are
// null_value=1, number_value=2, string_value=3, bool_value=4, struct_value=5,
// list_value=6.

const (
	pbValueNull   = 1
	pbValueNumber = 2
	pbValueString = 3
	pbValueBool   = 4
	pbValueStruct = 5
	pbValueList   = 6

	pbStructFields = 1
	pbMapKey       = 1
	pbMapValue     = 2
	pbListValues   = 1
)

// encodeProtoValue encodes a decoded-JSON Go value as google.protobuf.Value.
//
// The oneof body is emitted without an outer tag because this is called from
// inside a field writer that supplies the enclosing tag.
func encodeProtoValue(value any) []byte {
	var w pbWriter
	switch v := value.(type) {
	case nil:
		w.fieldVarint(pbValueNull, 0)
	case bool:
		if v {
			w.fieldVarint(pbValueBool, 1)
		} else {
			w.fieldVarint(pbValueBool, 0)
		}
	case float64:
		w.fieldDouble(pbValueNumber, v)
	case int:
		w.fieldDouble(pbValueNumber, float64(v))
	case int64:
		w.fieldDouble(pbValueNumber, float64(v))
	case string:
		w.fieldString(pbValueString, v)
	case []any:
		var list pbWriter
		for _, item := range v {
			list.fieldBytes(pbListValues, encodeProtoValue(item))
		}
		w.fieldBytes(pbValueList, list.bytes())
	case map[string]any:
		// Go map iteration is random. A protobuf map field is semantically
		// unordered, so the encoding stays valid — but a stable order makes the
		// frame reproducible, which the tests rely on.
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sortStrings(keys)
		var structWriter pbWriter
		for _, key := range keys {
			var entry pbWriter
			entry.fieldString(pbMapKey, key)
			entry.fieldBytes(pbMapValue, encodeProtoValue(v[key]))
			structWriter.fieldBytes(pbStructFields, entry.bytes())
		}
		w.fieldBytes(pbValueStruct, structWriter.bytes())
	default:
		w.fieldString(pbValueString, fmt.Sprintf("%v", v))
	}
	return w.bytes()
}

// decodeProtoValue decodes google.protobuf.Value back into a Go value.
func decodeProtoValue(b []byte) (any, error) {
	fields, err := pbMessage(b)
	if err != nil {
		return nil, err
	}
	switch {
	case pbHas(fields, pbValueNull):
		return nil, nil
	case pbHas(fields, pbValueBool):
		return pbFirstVarint(fields, pbValueBool) != 0, nil
	case pbHas(fields, pbValueNumber):
		raw := pbFirstBytes(fields, pbValueNumber)
		if len(raw) < 8 {
			return nil, errors.New("cursor pb: number_value is shorter than 8 bytes")
		}
		return math.Float64frombits(binary.LittleEndian.Uint64(raw)), nil
	case pbHas(fields, pbValueString):
		return pbFirstString(fields, pbValueString), nil
	case pbHas(fields, pbValueStruct):
		return decodeProtoStruct(pbFirstBytes(fields, pbValueStruct))
	case pbHas(fields, pbValueList):
		inner, err := pbMessage(pbFirstBytes(fields, pbValueList))
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, entry := range inner[pbListValues] {
			item, err := decodeProtoValue(entry.Bytes)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, nil
	}
	return nil, nil
}

func decodeProtoStruct(b []byte) (map[string]any, error) {
	fields, err := pbMessage(b)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for _, entry := range fields[pbStructFields] {
		pair, err := pbMessage(entry.Bytes)
		if err != nil {
			return nil, err
		}
		key := pbFirstString(pair, pbMapKey)
		if key == "" {
			continue
		}
		value, err := decodeProtoValue(pbFirstBytes(pair, pbMapValue))
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}
