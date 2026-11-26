"""Stage and verify the Universal DocBogi 1.1.6 installer payload."""

from install_macos_payload_114 import main


if __name__ == "__main__":
    main(base_version="1.1.5", target_version="1.1.6")
