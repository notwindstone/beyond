#!/bin/bash
# Profiles a server under callgrind: warm-up, counters zeroed, N requests
# to PATH, dump. Usage: cgserve.sh OUT N PATH cmd...
out=$1; n=$2; path=$3; shift 3
valgrind --tool=callgrind --smc-check=all --callgrind-out-file=$out "$@" > /dev/null 2> $out.err &
vpid=$!
for i in $(seq 300); do curl -s -o /dev/null http://127.0.0.1:3000/ && break; sleep 0.5; done
oha -n ${WARM:-2000} -c 4 --no-tui "http://127.0.0.1:3000$path" > /dev/null
callgrind_control -z $vpid > /dev/null
oha -n $n -c 4 --no-tui "http://127.0.0.1:3000$path" > /dev/null
callgrind_control -d $vpid > /dev/null
kill $vpid; wait $vpid 2>/dev/null
ls $out*
