# Native input images

Small synthetic PNG, JPEG and WebP fixtures for the PostgreSQL input/provenance
qualification. These are the original bytes from the retained native
input qualification.
They require no image-generation dependency at test time. The driver copies them
into each fresh fixture and compares acquisition, model wire data and retained
SHA-256 receipts against those exact bytes.
