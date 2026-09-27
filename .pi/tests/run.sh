#!/bin/sh
set -eu
learning_test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun test --preload "$learning_test_dir/pi-runtime.ts" "$learning_test_dir/learning.test.ts" "$learning_test_dir/tutor.test.ts"
