#!/opt/xunjie-school-acme/bin/python
"""Run this school's Certbot with IPv4 DNS results only."""
import socket
import sys

import urllib3.util.connection
urllib3.util.connection.allowed_gai_family = lambda: socket.AF_INET

from certbot._internal.main import main  # noqa: E402 - address family set before Certbot import

sys.exit(main())
