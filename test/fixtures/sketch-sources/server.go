package server

import (
	"net/http"
	"time"
)

/** Config holds server settings. */
type Config struct {
	Addr    string
	Timeout time.Duration
}

// Server wraps http.Server.
type Server struct {
	cfg Config
}

/** New builds a server from cfg. */
func New(cfg Config) *Server {
	return &Server{cfg: cfg}
}

func (s *Server) Start() error {
	return http.ListenAndServe(s.cfg.Addr, nil)
}

var DefaultConfig = Config{Addr: ":8080", Timeout: 5 * time.Second}
