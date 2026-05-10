package catalog

import (
	"errors"
	"net"
	"net/url"
	"syscall"

	"github.com/apache/iceberg-go/catalog/rest"
)

// MapError converts an iceberg-go / network error into a user-facing message
// suitable for direct display in the UI. Returns "" if err is nil.
func MapError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, ErrFilter) {
		return err.Error()
	}
	switch {
	case errors.Is(err, rest.ErrUnauthorized),
		errors.Is(err, rest.ErrAuthorizationExpired),
		errors.Is(err, rest.ErrOAuthError):
		return "Authentication failed: check the bearer token."
	case errors.Is(err, rest.ErrForbidden):
		return "Forbidden: token lacks permission for this catalog."
	case errors.Is(err, rest.ErrServiceUnavailable):
		return "Catalog service is unavailable. Try again shortly."
	case errors.Is(err, rest.ErrServerError):
		return "Catalog server error: " + err.Error()
	}

	if urlErr, ok := errors.AsType[*url.Error](err); ok {
		return classifyNet(urlErr)
	}

	if errors.Is(err, rest.ErrRESTError) {
		return "Catalog rejected the request: " + err.Error()
	}
	return "Unexpected error: " + err.Error()
}

func classifyNet(urlErr *url.Error) string {
	target := urlErr.URL
	if urlErr.Timeout() {
		return "Connection to " + target + " timed out."
	}
	if dnsErr, ok := errors.AsType[*net.DNSError](urlErr); ok {
		return "Host not found: " + dnsErr.Name + "."
	}
	if errors.Is(urlErr, syscall.ECONNREFUSED) {
		return "Connection refused at " + target + "."
	}
	return "Cannot reach " + target + ": " + urlErr.Err.Error()
}
