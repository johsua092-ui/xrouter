package main

import (
	"fmt"

	"github.com/johsua092-ui/xrouter/internal/providers"
)

func main() {
	r := providers.NewRegistry()
	providers.RegisterDefaults(r)
	providers.RegisterWave2(r)
	providers.RegisterWave3(r)
	providers.RegisterWave4(r)
	providers.RegisterWave5(r)
	providers.RegisterWave6(r)
	providers.RegisterWave7(r)
	providers.RegisterWave8(r)
	providers.RegisterWave8Anthropic(r)
	names := r.Names()
	fmt.Println("TOTAL:", len(names))
	for _, n := range names {
		fmt.Println(n)
	}
}
