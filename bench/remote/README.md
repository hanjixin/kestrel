Remote benchmark on the test servers: kestrel/node/bun serve on GPU node A,
wrk runs on GPU node B, both x86_64 Linux on the same LAN. See run.sh.

run.sh reads the hosts from the environment: BENCH_JUMP (jump host), BENCH_JUMP_PORT (default 22),
BENCH_JUMP_USER (default ubuntu), BENCH_NODE_A, BENCH_NODE_B, BENCH_ASKPASS (a script that prints
the SSH password) and ZGP_DEPLOY_PASSWORD (the password itself).
