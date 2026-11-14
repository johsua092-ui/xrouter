package main

import (
	"fmt"

	"github.com/johsua092-ui/xrouter/internal/providers"
)

func itoa(n int) string {
	if n == 0 { return "0" }
	var b [20]byte
	i := len(b)
	for n > 0 { i--; b[i] = byte('0'+n%10); n /= 10 }
	return string(b[i:])
}

func main() {
	pass, fail := 0, 0
	for _, prefix := range []string{"a_", "ab_", "abc_100_", "salt_1700000000_"} {
		for _, n := range []int{0, 1, 9, 10, 137, 30037, 199999} {
			want := providers.DeepSeekHashV1(prefix + itoa(n))
			got, err := providers.FindDeepSeekPowNonce(prefix, want, 200000)
			if got == n && err == nil { pass++ } else {
				fail++
				fmt.Printf("FAIL prefix=%q n=%d got=%d err=%v\n", prefix, n, got, err)
			}
		}
	}
	fmt.Printf("search vectors: %d pass, %d fail\n", pass, fail)
	// control
	h := providers.FIPS202Control("abc")
	fmt.Printf("control(abc)=%s want=3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532 ok=%v\n",
		h, h == "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532")
}
