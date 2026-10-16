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
    {"version", 0, Version, 0, 0, 0, napi_default, 0},
  };
  if (napi_define_properties(env, exports, sizeof props / sizeof *props, props) != napi_ok) return NULL;
  napi_property_descriptor m[] = { {"add", 0, CounterAdd, 0, 0, 0, napi_default, 0} };
  napi_value cls;
  if (napi_define_class(env, "Counter", NAPI_AUTO_LENGTH, CounterNew, NULL, 1, m, &cls) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "Counter", cls) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(hello, Init)
