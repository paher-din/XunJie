;; Restricted table-aggregation algorithm. The boundaries are enforced by the host,
;; not declared by this module:
;;   * the only import is the host-provided linear memory `env.memory`; there are no
;;     function, table or global imports, so the algorithm cannot reach the network,
;;     storage or any other host capability;
;;   * the host pins that memory's maximum to the manifest page count (16 MiB by
;;     default) before instantiation, so the module cannot grow beyond the budget;
;;   * input is `count` little-endian f64 values at `ptr`; the result is one f64 whose
;;     meaning is selected by `mode`. Invalid input returns NaN, which the host maps to
;;     invalid-input instead of inventing a number.
;;
;; mode: 0 = count, 1 = sum, 2 = mean, 3 = minimum, 4 = maximum.
;; See README.md for the human-readable Chinese description of these rules.
(module
  (import "env" "memory" (memory 1))
  (global (export "abiVersion") i32 (i32.const 1))
  (func (export "aggregate") (param $ptr i32) (param $count i32) (param $mode i32) (result f64)
    (local $i i32) (local $acc f64) (local $value f64)
    (if (i32.le_s (local.get $count) (i32.const 0)) (then (return (f64.const nan))))
    (if (i32.gt_u (local.get $mode) (i32.const 4)) (then (return (f64.const nan))))
    (if (i32.eq (local.get $mode) (i32.const 0)) (then (return (f64.convert_i32_s (local.get $count)))))
    (if (i32.eq (local.get $mode) (i32.const 3)) (then (local.set $acc (f64.const inf))))
    (if (i32.eq (local.get $mode) (i32.const 4)) (then (local.set $acc (f64.const -inf))))
    (block $finished
      (loop $next
        (br_if $finished (i32.ge_s (local.get $i) (local.get $count)))
        (local.set $value (f64.load (i32.add (local.get $ptr) (i32.mul (local.get $i) (i32.const 8)))))
        (if (i32.lt_u (local.get $mode) (i32.const 3))
          (then (local.set $acc (f64.add (local.get $acc) (local.get $value)))))
        (if (i32.eq (local.get $mode) (i32.const 3))
          (then (local.set $acc (f64.min (local.get $acc) (local.get $value)))))
        (if (i32.eq (local.get $mode) (i32.const 4))
          (then (local.set $acc (f64.max (local.get $acc) (local.get $value)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)
      )
    )
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (return (f64.div (local.get $acc) (f64.convert_i32_s (local.get $count))))))
    (local.get $acc)
  )
)
