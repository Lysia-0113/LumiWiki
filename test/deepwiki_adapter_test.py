from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from adalflow.core.types import ModelType
from scripts.deepwiki_entry import OpenAIClient, apply_directory_argument_fix


@pytest.mark.asyncio
async def test_chat_uses_chat_completions_and_keeps_embedding_endpoint():
    client = OpenAIClient(api_key="fixture-key", base_url="http://127.0.0.1:1/v1")
    chat = AsyncMock(return_value="chat-stream")
    embed = AsyncMock(return_value="embedding")
    client.async_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=chat)),
        embeddings=SimpleNamespace(create=embed),
    )
    kwargs = client.convert_inputs_to_api_kwargs(
        "请生成 Wiki", {"model": "fixture", "stream": True}, ModelType.LLM
    )
    assert kwargs["messages"] == [{"role": "user", "content": "请生成 Wiki"}]
    assert "input" not in kwargs
    assert await client.acall(kwargs, ModelType.LLM) == "chat-stream"
    chat.assert_awaited_once()
    assert await client.acall({"model": "embedding", "input": ["a"]}, ModelType.EMBEDDER) == "embedding"
    embed.assert_awaited_once()


def test_directory_filters_are_passed_to_the_correct_arguments(tmp_path):
    from api.services.wiki import tasks

    (tmp_path / "main.go").write_text("package main")
    (tmp_path / "ignored").mkdir()
    (tmp_path / "ignored" / "secret.go").write_text("package ignored")
    apply_directory_argument_fix()
    files, _ = tasks.read_repo_file_tree(str(tmp_path), ["ignored"], [], [], [])
    assert any(p.endswith("main.go") for p in files)
    assert not any("secret.go" in p for p in files)
