import re

WORD = re.compile(r"\w+")


def tokens(text: str) -> list[str]:
    """Lowercase word tokens."""
    return [w.lower() for w in WORD.findall(text)]


class Tokenizer:
    def __init__(self, stopwords=None):
        self.stopwords = set(stopwords or [])

    def __call__(self, text):
        return [t for t in tokens(text) if t not in self.stopwords]

    class Options:
        lowercase = True


async def tokenize_all(texts):
    return [tokens(t) for t in texts]
