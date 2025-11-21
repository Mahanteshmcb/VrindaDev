# Reconstructed tool definitions based on the provided information.
# Note: The function bodies are placeholders as the implementation is not available.

from typing import List, Dict, Any, Optional

def read_file(path: str) -> str:
    """Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead."""
    pass

def read_text_file(path: str, head: Optional[int] = None, tail: Optional[int] = None) -> str:
    """
    Read the complete contents of a file from the file system as text.
    Handles various text encodings and provides detailed error messages if the file cannot be read.
    Use this tool when you need to examine the contents of a single file.
    Use the 'head' parameter to read only the first N lines of a file,
    or the 'tail' parameter to read only the last N lines of a file.
    Operates on the file as text regardless of extension.
    Only works within allowed directories.
    """
    pass

def read_media_file(path: str) -> Dict[str, str]:
    """
    Read an image or audio file. Returns the base64 encoded data and MIME type.
    Only works within allowed directories.
    """
    pass

def read_multiple_files(paths: List[str]) -> Dict[str, str]:
    """
    Read the contents of multiple files simultaneously.
    This is more efficient than reading files one by one when you need to analyze or compare multiple files.
    Each file's content is returned with its path as a reference.
    Failed reads for individual files won't stop the entire operation.
    Only works within allowed directories.
    """
    pass

def write_file(path: str, content: str) -> None:
    """
    Create a new file or completely overwrite an existing file with new content.
    Use with caution as it will overwrite existing files without warning.
    Handles text content with proper encoding.
    Only works within allowed directories.
    """
    pass

def edit_file(path: str, edits: List[Dict[str, Any]]) -> str:
    """
    Make line-based edits to a text file. Each edit replaces exact line sequences with new content.
    Returns a git-style diff showing the changes made.
    Only works within allowed directories.
    """
    pass

def create_directory(path: str) -> None:
    """
    Create a new directory or ensure a directory exists.
    Can create multiple nested directories in one operation.
    If the directory already exists, this operation will succeed silently.
    Perfect for setting up directory structures for projects or ensuring required paths exist.
    Only works within allowed directories.
    """
    pass

def list_directory(path: str = '.') -> List[Dict[str, Any]]:
    """
    Get a detailed listing of all files and directories in a specified path.
    Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes.
    This tool is essential for understanding directory structure and finding specific files within a directory.
    Only works within allowed directories.
    """
    pass

def list_directory_with_sizes(path: str = '.') -> List[Dict[str, Any]]:
    """
    Get a detailed listing of all files and directories in a specified path, including sizes.
    Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes.
    This tool is useful for understanding directory structure and finding specific files within a directory.
    Only works within allowed directories.
    """
    pass

def directory_tree(path: str = '.') -> Dict[str, Any]:
    """
    Get a recursive tree view of files and directories as a JSON structure.
    Each entry includes 'name', 'type' (file/directory), and 'children' for directories.
    Files have no children array, while directories always have a children array (which may be empty).
    The output is formatted with 2-space indentation for readability.
    Only works within allowed directories.
    """
    pass

def move_file(source: str, destination: str) -> None:
    """
    Move or rename files and directories.
    Can move files between directories and rename them in a single operation.
    If the destination exists, the operation will fail.
    Works across different directories and can be used for simple renaming within the same directory.
    Both source and destination must be within allowed directories.
    """
    pass

def search_files(pattern: str, path: str = '.') -> List[str]:
    """
    Recursively search for files and directories matching a pattern.
    Searches through all subdirectories from the starting path.
    The search is case-insensitive and matches partial names.
    Returns full paths to all matching items.
    Great for finding files when you don't know their exact location.
    Only searches within allowed directories.
    """
    pass

def get_file_info(path: str) -> Dict[str, Any]:
    """
    Retrieve detailed metadata about a file or directory.
    Returns comprehensive information including size, creation time, last modified time, permissions, and type.
    This tool is perfect for understanding file characteristics without reading the actual content.
    Only works within allowed directories.
    """
    pass

def list_allowed_directories() -> List[str]:
    """
    Returns the list of directories that this server is allowed to access.
    Subdirectories within these allowed directories are also accessible.
    Use this to understand which directories and their nested paths are available
    before trying to access files.
    """
    pass
