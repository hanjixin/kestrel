// Minimal Node-API addon used by test/compat/napi.cjs: numbers, strings, buffers,
// objects, callbacks, exceptions, wrapped native objects and async work.
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define CHECK(x) if ((x) != napi_ok) { napi_throw_error(env, NULL, #x); return NULL; }

static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  double a, b; CHECK(napi_get_value_double(env, args[0], &a)); CHECK(napi_get_value_double(env, args[1], &b));
  napi_value r; CHECK(napi_create_double(env, a + b, &r)); return r;
}

static napi_value Shout(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  char buf[256]; size_t len;
  CHECK(napi_get_value_string_utf8(env, args[0], buf, sizeof buf, &len));
  for (size_t i = 0; i < len; i++) if (buf[i] >= 'a' && buf[i] <= 'z') buf[i] -= 32;
  napi_value r; CHECK(napi_create_string_utf8(env, buf, len, &r)); return r;
}

static napi_value Fill(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  uint32_t n, byte; CHECK(napi_get_value_uint32(env, args[0], &n)); CHECK(napi_get_value_uint32(env, args[1], &byte));
  void* data; napi_value buf; CHECK(napi_create_buffer(env, n, &data, &buf));
  memset(data, byte, n); return buf;
}

static napi_value Sum(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  bool is; CHECK(napi_is_buffer(env, args[0], &is));
  if (!is) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "buffer expected"); return NULL; }
  void* data; size_t len; CHECK(napi_get_buffer_info(env, args[0], &data, &len));
  unsigned long s = 0; for (size_t i = 0; i < len; i++) s += ((unsigned char*)data)[i];
  napi_value r; CHECK(napi_create_uint32(env, (uint32_t)s, &r)); return r;
}

static napi_value CallTwice(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  napi_value global, r1, r2; CHECK(napi_get_global(env, &global));
  CHECK(napi_call_function(env, global, args[0], 1, &args[1], &r1));
  CHECK(napi_call_function(env, global, args[0], 1, &r1, &r2));
  return r2;
}

static napi_value Describe(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  napi_valuetype t; CHECK(napi_typeof(env, args[0], &t));
  const char* names[] = {"undefined","null","boolean","number","string","symbol","object","function","external","bigint"};
  napi_value r; CHECK(napi_create_string_utf8(env, names[t], NAPI_AUTO_LENGTH, &r)); return r;
}

static napi_value Throws(napi_env env, napi_callback_info info) {
  napi_throw_error(env, "E_BOOM", "boom from native"); return NULL;
}

typedef struct { double total; } Counter;
static void CounterFinalize(napi_env env, void* data, void* hint) { free(data); }
static napi_value CounterNew(napi_env env, napi_callback_info info) {
  napi_value self; CHECK(napi_get_cb_info(env, info, NULL, NULL, &self, NULL));
  Counter* c = calloc(1, sizeof *c);
  CHECK(napi_wrap(env, self, c, CounterFinalize, NULL, NULL)); return self;
}
static napi_value CounterAdd(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1], self;
  CHECK(napi_get_cb_info(env, info, &argc, args, &self, NULL));
  Counter* c; CHECK(napi_unwrap(env, self, (void**)&c));
  double v; CHECK(napi_get_value_double(env, args[0], &v)); c->total += v;
  napi_value r; CHECK(napi_create_double(env, c->total, &r)); return r;
}

typedef struct { napi_async_work work; napi_deferred deferred; double input; double result; } Job;
static void JobExecute(napi_env env, void* data) { Job* j = data; j->result = j->input * j->input; }
static void JobComplete(napi_env env, napi_status status, void* data) {
  Job* j = data; napi_value r; napi_create_double(env, j->result, &r);
  napi_resolve_deferred(env, j->deferred, r); napi_delete_async_work(env, j->work); free(j);
}
static napi_value SquareAsync(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  Job* j = calloc(1, sizeof *j); CHECK(napi_get_value_double(env, args[0], &j->input));
  napi_value promise, name; CHECK(napi_create_promise(env, &j->deferred, &promise));
  CHECK(napi_create_string_utf8(env, "square", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_async_work(env, NULL, name, JobExecute, JobComplete, j, &j->work));
  CHECK(napi_queue_async_work(env, j->work)); return promise;
}

// Callback kept in a reference and invoked from an async-work completion (ObjectWrap-style
// weak wrap reference for `this`), as node-addon-api based addons do.
typedef struct { napi_ref cb; napi_ref self; napi_async_work work; double total; } LaterJob;
static void LaterExecute(napi_env env, void* data) { (void)env; (void)data; }
static void LaterComplete(napi_env env, napi_status status, void* data) {
  LaterJob* l = data; napi_value cb, self, arg, r; napi_valuetype t;
  napi_get_reference_value(env, l->cb, &cb); napi_typeof(env, cb, &t);
  if (l->self) napi_get_reference_value(env, l->self, &self); else napi_get_global(env, &self);
  napi_create_double(env, t == napi_function ? l->total : -1, &arg);
  if (napi_call_function(env, self, cb, 1, &arg, &r) != napi_ok) { napi_value e; napi_get_and_clear_last_exception(env, &e); napi_fatal_exception(env, e); }
  napi_delete_reference(env, l->cb); napi_delete_async_work(env, l->work); free(l);
}
static napi_value LaterFn(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2], name;
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  LaterJob* l = calloc(1, sizeof *l);
  CHECK(napi_get_value_double(env, args[0], &l->total));
  CHECK(napi_create_reference(env, args[1], 1, &l->cb));
  CHECK(napi_create_string_utf8(env, "later", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_async_work(env, NULL, name, LaterExecute, LaterComplete, l, &l->work));
  CHECK(napi_queue_async_work(env, l->work));
  napi_value u; CHECK(napi_get_undefined(env, &u)); return u;
}
typedef struct { napi_ref self; double total; } Wrapped;
static void WrappedFinalize(napi_env env, void* data, void* hint) { free(data); }
static napi_value WrappedNew(napi_env env, napi_callback_info info) {
  napi_value self; CHECK(napi_get_cb_info(env, info, NULL, NULL, &self, NULL));
  Wrapped* w = calloc(1, sizeof *w);
  CHECK(napi_wrap(env, self, w, WrappedFinalize, NULL, &w->self)); // weak reference, like ObjectWrap
  return self;
}
static napi_value WrappedAddLater(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2], self, name;
  CHECK(napi_get_cb_info(env, info, &argc, args, &self, NULL));
  Wrapped* w; CHECK(napi_unwrap(env, self, (void**)&w));
  double v; CHECK(napi_get_value_double(env, args[0], &v)); w->total += v;
  LaterJob* l = calloc(1, sizeof *l); l->total = w->total; l->self = w->self;
  CHECK(napi_create_reference(env, args[1], 1, &l->cb));
  CHECK(napi_create_string_utf8(env, "addLater", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_async_work(env, NULL, name, LaterExecute, LaterComplete, l, &l->work));
  CHECK(napi_queue_async_work(env, l->work));
  return self;
}

// Handle stability: argument handles must stay valid across many intermediate
// allocations within one native call (node-addon-api relies on this everywhere).
static napi_value Stress(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  for (int i = 0; i < 200; i++) { napi_value tmp, o; CHECK(napi_create_string_utf8(env, "filler string value", NAPI_AUTO_LENGTH, &tmp)); CHECK(napi_create_object(env, &o)); CHECK(napi_set_named_property(env, o, "k", tmp)); }
  napi_valuetype t0, t1; CHECK(napi_typeof(env, args[0], &t0)); CHECK(napi_typeof(env, args[1], &t1));
  napi_ref ref; CHECK(napi_create_reference(env, args[1], 1, &ref));
  for (int i = 0; i < 200; i++) { napi_value tmp; CHECK(napi_create_double(env, i, &tmp)); }
  napi_value back; CHECK(napi_get_reference_value(env, ref, &back));
  napi_valuetype t2; CHECK(napi_typeof(env, back, &t2));
  napi_value r; CHECK(napi_call_function(env, args[0], back, 1, &args[0], &r));
  napi_valuetype t3; CHECK(napi_typeof(env, r, &t3));
  CHECK(napi_delete_reference(env, ref));
  char buf[64]; snprintf(buf, sizeof buf, "%d,%d,%d,%d", t0, t1, t2, t3);
  napi_value out; CHECK(napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out)); return out;
}

// node-addon-api ObjectWrap constructor sequence (instanceof, unwrap, defineProperty on
// `this`, then a reference to the callback argument), as node-sqlite3's Statement does.
static napi_ref g_wrapped_ctor;
static napi_value StmtNew(napi_env env, napi_callback_info info) {
  size_t argc = 6; napi_value args[6], self;
  CHECK(napi_get_cb_info(env, info, &argc, args, &self, NULL));
  napi_value ctor; CHECK(napi_get_reference_value(env, g_wrapped_ctor, &ctor));
  bool inst; CHECK(napi_instanceof(env, args[0], ctor, &inst));
  Wrapped* w; CHECK(napi_unwrap(env, args[0], (void**)&w));
  napi_valuetype t1; CHECK(napi_typeof(env, args[1], &t1));
  napi_property_descriptor pd = {"sql", 0, 0, 0, 0, args[1], napi_default, 0};
  CHECK(napi_define_properties(env, self, 1, &pd));
  napi_valuetype t2; CHECK(napi_typeof(env, args[2], &t2));
  napi_ref ref; CHECK(napi_create_reference(env, args[2], 1, &ref));
  char sqlbuf[64]; size_t n; CHECK(napi_get_value_string_utf8(env, args[1], sqlbuf, sizeof sqlbuf, &n));
  napi_value back; CHECK(napi_get_reference_value(env, ref, &back));
  napi_valuetype t3; CHECK(napi_typeof(env, back, &t3));
  char buf[96]; snprintf(buf, sizeof buf, "%d,%d,%d,%d,%d,%s", (int)argc, inst, t1, t2, t3, sqlbuf);
  napi_value out; CHECK(napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out));
  CHECK(napi_set_named_property(env, self, "report", out));
  CHECK(napi_delete_reference(env, ref));
  return self;
}

static napi_value Version(napi_env env, napi_callback_info info) {
  const napi_node_version* v; CHECK(napi_get_node_version(env, &v));
  uint32_t nv; CHECK(napi_get_version(env, &nv));
  napi_value r, maj, api; CHECK(napi_create_object(env, &r));
  CHECK(napi_create_uint32(env, v->major, &maj)); CHECK(napi_set_named_property(env, r, "major", maj));
  CHECK(napi_create_uint32(env, nv, &api)); CHECK(napi_set_named_property(env, r, "napi", api));
  return r;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"add", 0, Add, 0, 0, 0, napi_default, 0}, {"shout", 0, Shout, 0, 0, 0, napi_default, 0},
    {"fill", 0, Fill, 0, 0, 0, napi_default, 0}, {"sum", 0, Sum, 0, 0, 0, napi_default, 0},
    {"callTwice", 0, CallTwice, 0, 0, 0, napi_default, 0}, {"describe", 0, Describe, 0, 0, 0, napi_default, 0},
    {"throws", 0, Throws, 0, 0, 0, napi_default, 0}, {"squareAsync", 0, SquareAsync, 0, 0, 0, napi_default, 0},
    {"version", 0, Version, 0, 0, 0, napi_default, 0}, {"later", 0, LaterFn, 0, 0, 0, napi_default, 0}, {"stress", 0, Stress, 0, 0, 0, napi_default, 0},
  };
  if (napi_define_properties(env, exports, sizeof props / sizeof *props, props) != napi_ok) return NULL;
  napi_property_descriptor m[] = { {"add", 0, CounterAdd, 0, 0, 0, napi_default, 0} };
  napi_value cls;
  if (napi_define_class(env, "Counter", NAPI_AUTO_LENGTH, CounterNew, NULL, 1, m, &cls) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "Counter", cls) != napi_ok) return NULL;
  napi_property_descriptor wm[] = { {"addLater", 0, WrappedAddLater, 0, 0, 0, napi_default, 0} };
  napi_value wcls;
  if (napi_define_class(env, "Wrapped", NAPI_AUTO_LENGTH, WrappedNew, NULL, 1, wm, &wcls) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "Wrapped", wcls) != napi_ok) return NULL;
  if (napi_create_reference(env, wcls, 1, &g_wrapped_ctor) != napi_ok) return NULL;
  napi_value scls;
  if (napi_define_class(env, "Stmt", NAPI_AUTO_LENGTH, StmtNew, NULL, 0, NULL, &scls) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "Stmt", scls) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(hello, Init)
