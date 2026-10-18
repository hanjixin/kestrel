//! Owned structured messages. ArrayBuffer backing stores move with the channel
//! message, so dropping an undelivered message also releases its transferred memory.
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use deno_core::{op2, v8, OpState};
use deno_error::JsErrorBox;
use v8::{ValueDeserializerHelper, ValueSerializerHelper};

pub struct Message {
    bytes: Vec<u8>,
    transfers: Vec<v8::SharedRef<v8::BackingStore>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
}
#[derive(Default)]
struct Messages { next: u32, values: HashMap<u32, Message> }
pub fn store(state: &mut OpState, message: Message) -> u32 {
    if state.try_borrow::<Messages>().is_none() { state.put(Messages::default()); }
    let messages = state.borrow_mut::<Messages>();
    let mut id = messages.next;
    while messages.values.contains_key(&id) { id = id.wrapping_add(1); }
    messages.next = id.wrapping_add(1);
    messages.values.insert(id, message);
    id
}
pub fn take(state: &mut OpState, id: u32) -> Result<Message, JsErrorBox> {
    state.try_borrow_mut::<Messages>().and_then(|m| m.values.remove(&id))
        .ok_or_else(|| JsErrorBox::type_error("message already consumed"))
}
struct Serializer { shared: Rc<RefCell<Vec<v8::SharedRef<v8::BackingStore>>>> }
impl v8::ValueSerializerImpl for Serializer {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        let error = v8::Exception::error(scope, message);
        let object = error.to_object(scope).unwrap();
        let key = v8::String::new(scope, "name").unwrap();
        let name = v8::String::new(scope, "DataCloneError").unwrap();
        object.set(scope, key.into(), name.into());
        scope.throw_exception(error);
    }
    fn get_shared_array_buffer_id<'s>(&self, _scope: &mut v8::PinScope<'s, '_>, buffer: v8::Local<'s, v8::SharedArrayBuffer>) -> Option<u32> {
        let mut shared = self.shared.borrow_mut();
        let id = shared.len() as u32;
        shared.push(buffer.get_backing_store());
        Some(id)
    }
}
struct Deserializer { shared: Vec<v8::SharedRef<v8::BackingStore>> }
impl v8::ValueDeserializerImpl for Deserializer {
    fn get_shared_array_buffer_from_id<'s>(&self, scope: &mut v8::PinScope<'s, '_>, id: u32) -> Option<v8::Local<'s, v8::SharedArrayBuffer>> {
        self.shared.get(id as usize).map(|b| v8::SharedArrayBuffer::with_backing_store(scope, b))
    }
}

#[op2(fast, reentrant)]
pub fn op_clone_encode(scope: &mut v8::PinScope, state: Rc<RefCell<OpState>>, value: v8::Local<v8::Value>, transfers: v8::Local<v8::Array>) -> Result<u32, JsErrorBox> {
    let shared = Rc::new(RefCell::new(Vec::new()));
    let serializer = v8::ValueSerializer::new(scope, Box::new(Serializer { shared: shared.clone() }));
    serializer.write_header();
    let mut buffers = Vec::new();
    for i in 0..transfers.length() {
        let value = transfers.get_index(scope, i).ok_or_else(|| JsErrorBox::type_error("invalid transfer list"))?;
        let buffer = v8::Local::<v8::ArrayBuffer>::try_from(value).map_err(|_| JsErrorBox::type_error("transfer item must be an ArrayBuffer"))?;
        if buffer.was_detached() || !buffer.is_detachable() || buffers.contains(&buffer) {
            return Err(JsErrorBox::type_error("invalid or duplicate transfer buffer"));
        }
        serializer.transfer_array_buffer(i, buffer);
        buffers.push(buffer);
    }
    // In particular, failed serialization must never detach a caller's buffer.
    v8::tc_scope!(let scope, scope);
    let written = serializer.write_value(scope.get_current_context(), value);
    if scope.has_caught() { scope.rethrow(); return Ok(0); }
    if written != Some(true) {
        return Err(JsErrorBox::type_error("value could not be cloned"));
    }
    let transfers = buffers.iter().map(|b| b.get_backing_store()).collect();
    for buffer in buffers { buffer.detach(None); }
    let message = Message { bytes: serializer.release(), transfers, shared: shared.take() };
    Ok(store(&mut state.borrow_mut(), message))
}

#[op2]
pub fn op_clone_decode<'s>(scope: &mut v8::PinScope<'s, '_>, state: &mut OpState, id: u32) -> Result<v8::Local<'s, v8::Value>, JsErrorBox> {
    let message = take(state, id)?;
    let decoder = v8::ValueDeserializer::new(scope, Box::new(Deserializer { shared: message.shared }), &message.bytes);
    if decoder.read_header(scope.get_current_context()) != Some(true) { return Err(JsErrorBox::type_error("invalid message header")); }
    for (id, backing) in message.transfers.iter().enumerate() {
        let buffer = v8::ArrayBuffer::with_backing_store(scope, backing);
        decoder.transfer_array_buffer(id as u32, buffer);
    }
    decoder.read_value(scope.get_current_context()).ok_or_else(|| JsErrorBox::type_error("invalid message"))
}

// Node advanced IPC uses V8 serialization with a host-object tag for typed
// arrays, preserving Buffer and avoiding serialization of an entire buffer pool.
struct IpcSerializer { buffer_prototype: v8::Global<v8::Value> }
impl v8::ValueSerializerImpl for IpcSerializer {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        let error = v8::Exception::error(scope, message); scope.throw_exception(error);
    }
    fn write_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>, writer: &dyn v8::ValueSerializerHelper) -> Option<bool> {
        let view = v8::Local::<v8::ArrayBufferView>::try_from(object).ok()?;
        let prototype = v8::Local::new(scope, &self.buffer_prototype);
        let kind = if object.get_prototype(scope) == Some(prototype) { 10 }
            else if object.is_int8_array() { 0 } else if object.is_uint8_array() { 1 }
            else if object.is_uint8_clamped_array() { 2 } else if object.is_int16_array() { 3 }
            else if object.is_uint16_array() { 4 } else if object.is_int32_array() { 5 }
            else if object.is_uint32_array() { 6 } else if object.is_float32_array() { 7 }
            else if object.is_float64_array() { 8 } else if object.is_data_view() { 9 }
            else if object.is_big_int64_array() { 11 } else if object.is_big_uint64_array() { 12 }
            else if object.is_float16_array() { 13 } else { return None };
        let mut bytes = vec![0; view.byte_length()]; view.copy_contents(&mut bytes);
        writer.write_uint32(0); // child_process ArrayBufferView tag
        writer.write_uint32(kind as u32);
        writer.write_uint32(bytes.len() as u32);
        writer.write_raw_bytes(&bytes);
        Some(true)
    }
}
struct IpcDeserializer { buffer_prototype: v8::Global<v8::Value> }
impl v8::ValueDeserializerImpl for IpcDeserializer {
    fn read_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, reader: &dyn v8::ValueDeserializerHelper) -> Option<v8::Local<'s, v8::Object>> {
        let (mut tag, mut kind, mut length) = (0, 0, 0);
        if !reader.read_uint32(&mut tag) || tag != 0 || !reader.read_uint32(&mut kind) || !reader.read_uint32(&mut length) { return None; }
        let (kind, length) = (kind as usize, length as usize);
        let bytes = reader.read_raw_bytes(length)?.to_vec();
        let backing = v8::ArrayBuffer::new_backing_store_from_boxed_slice(bytes.into_boxed_slice()).make_shared();
        let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing);
        let object: v8::Local<v8::Object> = match kind {
            0 => v8::Int8Array::new(scope, buffer, 0, length)?.into(),
            1 | 10 => v8::Uint8Array::new(scope, buffer, 0, length)?.into(),
            2 => v8::Uint8ClampedArray::new(scope, buffer, 0, length)?.into(),
            3 => v8::Int16Array::new(scope, buffer, 0, length / 2)?.into(),
            4 => v8::Uint16Array::new(scope, buffer, 0, length / 2)?.into(),
            5 => v8::Int32Array::new(scope, buffer, 0, length / 4)?.into(),
            6 => v8::Uint32Array::new(scope, buffer, 0, length / 4)?.into(),
            7 => v8::Float32Array::new(scope, buffer, 0, length / 4)?.into(),
            8 => v8::Float64Array::new(scope, buffer, 0, length / 8)?.into(),
            9 => v8::DataView::new(scope, buffer, 0, length).into(),
            11 => v8::BigInt64Array::new(scope, buffer, 0, length / 8)?.into(),
            12 => v8::BigUint64Array::new(scope, buffer, 0, length / 8)?.into(),
            // SAFETY: Float16Array is a V8 Object; this binding version omits its From impl.
            13 => unsafe { v8::Local::<v8::Object>::cast_unchecked(v8::Float16Array::new(scope, buffer, 0, length / 2)?) },
            _ => return None,
        };
        if kind == 10 {
            let prototype = v8::Local::new(scope, &self.buffer_prototype);
            object.set_prototype(scope, prototype)?;
        }
        Some(object)
    }
}
#[op2(reentrant)]
#[buffer]
pub fn op_ipc_encode(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Vec<u8>, JsErrorBox> {
    let buffer_prototype = ipc_buffer_prototype(scope)?;
    let writer = v8::ValueSerializer::new(scope, Box::new(IpcSerializer { buffer_prototype }));
    writer.set_treat_array_buffer_views_as_host_objects(true);
    writer.write_header();
    v8::tc_scope!(let scope, scope);
    let written = writer.write_value(scope.get_current_context(), value);
    if scope.has_caught() { scope.rethrow(); return Ok(Vec::new()); }
    if written != Some(true) { return Err(JsErrorBox::type_error("IPC message could not be cloned")); }
    Ok(writer.release())
}
#[op2(reentrant)]
pub fn op_ipc_decode<'s>(scope: &mut v8::PinScope<'s, '_>, #[buffer] bytes: &[u8]) -> Result<v8::Local<'s, v8::Value>, JsErrorBox> {
    let buffer_prototype = ipc_buffer_prototype(scope)?;
    let reader = v8::ValueDeserializer::new(scope, Box::new(IpcDeserializer { buffer_prototype }), bytes);
    if reader.read_header(scope.get_current_context()) != Some(true) { return Err(JsErrorBox::type_error("invalid IPC message")); }
    reader.read_value(scope.get_current_context()).ok_or_else(|| JsErrorBox::type_error("invalid IPC message"))
}

fn ipc_buffer_prototype(scope: &mut v8::PinScope) -> Result<v8::Global<v8::Value>, JsErrorBox> {
    let global = scope.get_current_context().global(scope);
    let name = v8::String::new(scope, "Buffer").unwrap();
    let constructor = global.get(scope, name.into()).and_then(|v| v.to_object(scope)).ok_or_else(|| JsErrorBox::type_error("Buffer constructor missing"))?;
    let key = v8::String::new(scope, "prototype").unwrap();
    let prototype = constructor.get(scope, key.into()).ok_or_else(|| JsErrorBox::type_error("Buffer prototype missing"))?;
    let buffer_prototype = v8::Global::new(scope, prototype);
    Ok(buffer_prototype)
}
