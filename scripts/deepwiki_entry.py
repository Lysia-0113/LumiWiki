"""适配上游 DeepWiki 的 OpenAI 协议与目录参数；不修改上游源码。"""
import os

import adalflow.components.model_client as clients
from adalflow.components.model_client.openai_client import OpenAIClient as BaseOpenAIClient
from adalflow.core.types import ModelType


class OpenAIClient(BaseOpenAIClient):
    def __init__(self, api_key=None, base_url=None, **kwargs):
        # 上游客户端默认 URL 是构造参数，不能仅依靠 OPENAI_BASE_URL 环境变量。
        super().__init__(
            api_key=api_key or os.environ.get("OPENAI_API_KEY"),
            base_url=base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            **kwargs,
        )

    def convert_inputs_to_api_kwargs(self, input=None, model_kwargs=None, model_type=ModelType.UNDEFINED):
        if model_type in (ModelType.LLM, ModelType.LLM_REASONING):
            # DeepWiki 的 streamer 消费 choices[].delta，必须使用 Chat Completions。
            kwargs = dict(model_kwargs or {})
            kwargs["messages"] = input if isinstance(input, list) else [{"role": "user", "content": input or ""}]
            return kwargs
        return super().convert_inputs_to_api_kwargs(input, model_kwargs or {}, model_type)

    async def acall(self, api_kwargs=None, model_type=ModelType.UNDEFINED):
        if model_type in (ModelType.LLM, ModelType.LLM_REASONING):
            if self.async_client is None:
                self.async_client = self.init_async_client()
            return await self.async_client.chat.completions.create(**(api_kwargs or {}))
        return await super().acall(api_kwargs or {}, model_type)


clients.OpenAIClient = OpenAIClient


def apply_directory_argument_fix():
    from api.services.wiki import tasks
    from api.services.wiki.structure import read_repo_file_tree

    # 固定上游调用位置参数的顺序；上游工具本身使用 included_* 在前的签名。
    def read_tree_for_task(path, excluded_dirs=None, excluded_files=None, included_dirs=None, included_files=None):
        return read_repo_file_tree(
            path,
            included_files=included_files,
            included_dirs=included_dirs,
            excluded_files=excluded_files,
            excluded_dirs=excluded_dirs,
        )

    tasks.read_repo_file_tree = read_tree_for_task

if __name__ == "__main__":
    import uvicorn

    apply_directory_argument_fix()
    uvicorn.run("api.main:app", host="127.0.0.1", port=int(os.environ.get("DEEPWIKI_PORT", "8001")))
