#!/bin/sh
# core@1.83.0 constructs the sandbox but omits capability dropping. Namespace
# setup needs these capabilities in the controller; model commands must not.
exec /usr/bin/bwrap --cap-drop ALL "$@"
