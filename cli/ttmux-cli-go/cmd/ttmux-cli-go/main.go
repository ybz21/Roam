package main

import (
	"fmt"
	"os"

	"ttmux-cli-go/internal/core"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 1 {
		return usage()
	}
	switch args[0] {
	case "swarm":
		return runSwarm(args[1:])
	default:
		return usage()
	}
}

func runSwarm(args []string) error {
	if len(args) < 1 {
		return usage()
	}
	switch args[0] {
	case "status":
		if len(args) < 2 {
			return fmt.Errorf("usage: ttmux-cli-go swarm status <name> --json")
		}
		jsonOut := false
		for _, a := range args[2:] {
			if a == "--json" {
				jsonOut = true
			}
		}
		if !jsonOut {
			return fmt.Errorf("ttmux-cli-go currently supports only: swarm status <name> --json")
		}
		out, err := core.StatusJSON(args[1], core.DefaultOptions())
		if err != nil {
			return err
		}
		fmt.Println(string(out))
		return nil
	default:
		return usage()
	}
}

func usage() error {
	return fmt.Errorf("usage: ttmux-cli-go swarm status <name> --json")
}
