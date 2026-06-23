package main

import (
	"fmt"
	"os"

	"ttmux-cli-go/internal/app"
)

func main() {
	if err := app.New().Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
