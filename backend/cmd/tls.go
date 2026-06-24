// 自签 TLS：手机经局域网用麦克风/剪贴板等能力，浏览器要求「安全上下文」(HTTPS)。
// 这里在证书缺失时就地生成一张自签证书，SAN 覆盖 localhost、回环与本机所有非回环 IP，
// 让手机用 https://<局域网IP>:<端口> 访问（首次点「继续前往」信任即可）。
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ensureSelfSignedCert 在 cert/key 任一缺失时生成自签证书对，返回是否新生成。
func ensureSelfSignedCert(certPath, keyPath string) (bool, error) {
	if fileExists(certPath) && fileExists(keyPath) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return false, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return false, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return false, err
	}
	dns := []string{"localhost"}
	ips := append([]net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}, localIPs()...)
	// 额外 SAN：TTMUX_WEB_TLS_SAN（逗号分隔）。经 frp/反代从公网 IP 或域名访问时填上，
	// 否则浏览器会因「证书域名不匹配」多报一条告警。是 IP 走 IPAddresses，否则当域名。
	for _, s := range strings.Split(os.Getenv("TTMUX_WEB_TLS_SAN"), ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		if ip := net.ParseIP(s); ip != nil {
			ips = append(ips, ip)
		} else {
			dns = append(dns, s)
		}
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "ttmux-web self-signed"},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0), // 10 年，免频繁重签
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dns,
		IPAddresses:           ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return false, err
	}

	certOut, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return false, err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		return false, err
	}

	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return false, err
	}
	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return false, err
	}
	defer keyOut.Close()
	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}); err != nil {
		return false, err
	}
	return true, nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// localIPs 枚举本机所有非回环单播 IP，写进证书 SAN，减少手机访问时的「域名不匹配」告警。
func localIPs() []net.IP {
	var ips []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		ips = append(ips, ip)
	}
	return ips
}
