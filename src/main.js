//@ts-check

var lang = require("./lang.js");
var SYSTEM_PROMPT = require("./const.js").SYSTEM_PROMPT;

var {
  buildHeader,
  ensureHttpsAndNoTrailingSlash,
  getApiKey,
  handleGeneralError,
  handleValidateError,
  replacePromptKeywords,
} = require("./utils.js");

/**
 * @param {Bob.TranslateQuery} query
 * @returns {{
 *  generatedSystemPrompt: string,
 *  generatedUserPrompt: string
 * }}
 */
function generatePrompts(query) {
    let generatedSystemPrompt = SYSTEM_PROMPT;
    const { detectFrom, detectTo } = query;
    const sourceLang = lang.langMap.get(detectFrom) || detectFrom;
    const targetLang = lang.langMap.get(detectTo) || detectTo;
    let generatedUserPrompt = `translate from ${sourceLang} to ${targetLang}`;

    if (detectTo === "wyw" || detectTo === "yue") {
        generatedUserPrompt = `翻译成${targetLang}`;
    }

    if (
        detectFrom === "wyw" ||
        detectFrom === "zh-Hans" ||
        detectFrom === "zh-Hant"
    ) {
        if (detectTo === "zh-Hant") {
            generatedUserPrompt = "翻译成繁体白话文";
        } else if (detectTo === "zh-Hans") {
            generatedUserPrompt = "翻译成简体白话文";
        } else if (detectTo === "yue") {
            generatedUserPrompt = "翻译成粤语白话文";
        }
    }
    if (detectFrom === detectTo) {
        generatedSystemPrompt =
            "You are a text embellisher, you can only embellish the text, don't interpret it.";
        if (detectTo === "zh-Hant" || detectTo === "zh-Hans") {
            generatedUserPrompt = "润色此句";
        } else {
            generatedUserPrompt = "polish this sentence";
        }
    }

    generatedUserPrompt = `${generatedUserPrompt}:\n\n${query.text}`

    return { generatedSystemPrompt, generatedUserPrompt };
}


/**
 * @param {Bob.TranslateQuery} query
 * @returns {{
 *  model: string;
 *  max_tokens: number;
 *  messages: {
 *    role: "user";
 *    content: string;
 *  }[];
 *  system?: string;
 *  stream?: boolean;
 * }}
 */
function buildRequestBody(query) {
  let { customSystemPrompt, customUserPrompt, model, maxTokens, stream } =
    $option;
  const { generatedSystemPrompt, generatedUserPrompt } = generatePrompts(query);

  customSystemPrompt = replacePromptKeywords(customSystemPrompt, query);
  customUserPrompt = replacePromptKeywords(customUserPrompt, query);

  const systemPrompt = customSystemPrompt || generatedSystemPrompt;
  const userPrompt = customUserPrompt || generatedUserPrompt;

  return {
    model: model,
    max_tokens: parseInt(maxTokens),
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
    system: systemPrompt,
    stream: stream === "1",
  };
}

/**
 * @param {Bob.TranslateQuery} query
 * @param {string} eventType
 * @param {string} eventData
 * @param {string} accumulatedText
 * @returns {string}
 */
function handleStreamResponse(query, eventType, eventData, accumulatedText) {
  try {
    const data = JSON.parse(eventData);
    switch (eventType) {
      case "content_block_delta":
        if (data.delta && data.delta.type === "text_delta") {
          const delta = data.delta.text;
          if (delta) {
            accumulatedText += delta;
            query.onStream({
              result: {
                from: query.detectFrom,
                to: query.detectTo,
                toParagraphs: [accumulatedText],
              },
            });
            return accumulatedText;
          }
        }
        break;
      // Handle other event types if needed
    }
  } catch (err) {
    $log.error("Error parsing event data: " + err.message);
    handleGeneralError(query, {
      type: err.type || "param",
      message: err.message || "Failed to parse JSON",
      addition: err.addition,
    });
  }
  return accumulatedText;
}
/**
 * @param {Bob.TranslateQuery} query
 * @param {Bob.HttpResponse} result
 * @returns {void}
 */
function handleGeneralResponse(query, result) {
  const { content } = result.data;

  if (!content || content.length === 0) {
    handleGeneralError(query, {
      type: "api",
      message: "接口未返回结果",
      addition: JSON.stringify(result),
    });
    return;
  }

  let targetText = content[0].text.trim();

  query.onCompletion({
    result: {
      from: query.detectFrom,
      to: query.detectTo,
      toParagraphs: targetText.split("\n"),
    },
  });
}

/**
 * @type {Bob.Translate}
 */
function translate(query) {
  if (!lang.langMap.get(query.detectTo)) {
    handleGeneralError(query, {
      type: "unsupportLanguage",
      message: "不支持该语种",
      addition: "不支持该语种",
    });
  }

  const { apiKeys, apiUrl, apiVersion, stream } = $option;

  if (!apiKeys) {
    handleGeneralError(query, {
      type: "secretKey",
      message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
      addition: "请在插件配置中填写 API Keys",
    });
  }

  const apiKey = getApiKey(apiKeys);
  const baseUrl = ensureHttpsAndNoTrailingSlash(
    apiUrl || "https://api.anthropic.com"
  );
  const apiUrlPath = "/v1/messages";

  const header = buildHeader(apiKey, apiVersion);
  const body = buildRequestBody(query);

  let accumulatedText = "";
  (async () => {
    if (stream === "1") {
      await $http.streamRequest({
        method: "POST",
        url: baseUrl + apiUrlPath,
        header,
        body,
        cancelSignal: query.cancelSignal,
        streamHandler: (streamData) => {
          $log.info("Received stream data: " + streamData.text);
          if (streamData.text !== undefined) {
            const lines = streamData.text.split("\n");
            let eventType = "";
            let eventData = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData = line.slice(6).trim();
                if (eventType && eventData) {
                  $log.info(`Processing event: ${eventType}`);
                  accumulatedText = handleStreamResponse(
                    query,
                    eventType,
                    eventData,
                    accumulatedText
                  );
                  $log.info(`Accumulated text: ${accumulatedText}`);
                  eventType = "";
                  eventData = "";
                }
              }
            }
          }
        },
        handler: (result) => {
          if (result.response.statusCode >= 400) {
            handleGeneralError(query, result);
          } else {
            query.onCompletion({
              result: {
                from: query.detectFrom,
                to: query.detectTo,
                toParagraphs: [accumulatedText],
              },
            });
          }
        },
      });
    } else {
      const result = await $http.request({
        method: "POST",
        url: baseUrl + apiUrlPath,
        header,
        body,
      });

      if (result.error) {
        handleGeneralError(query, result);
      } else {
        handleGeneralResponse(query, result);
      }
    }
  })().catch((err) => {
    handleGeneralError(query, err);
  });
}

function supportLanguages() {
  return lang.supportLanguages.map(([standardLang]) => standardLang);
}

/**
 * @type {Bob.PluginValidate}
 */
function pluginValidate(completion) {
  const { apiKeys, apiUrl, apiVersion, model } = $option;
  if (!apiKeys) {
    handleValidateError(completion, {
      type: "secretKey",
      message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
      addition: "请在插件配置中填写正确的 API Keys",
    });
    return;
  }

  const apiKey = getApiKey(apiKeys);
  const baseUrl = ensureHttpsAndNoTrailingSlash(
    apiUrl || "https://api.anthropic.com"
  );
  const apiUrlPath = "/v1/messages";

  const header = buildHeader(apiKey, apiVersion);
  const body = {
    model: model,
    max_tokens: 1,
    messages: [
      {
        role: "user",
        content: "Hello",
      },
    ],
    stream: false,
  };

  (async () => {
    $http.request({
      method: "POST",
      url: baseUrl + apiUrlPath,
      header: header,
      body: body,
      handler: function (resp) {
        if (resp.data.error) {
          handleValidateError(completion, {
            type: "api",
            message: resp.data.error.message || "API request failed",
          });
          return;
        }
        if (resp.data.content && resp.data.content.length > 0) {
          completion({
            result: true,
          });
        } else {
          handleValidateError(completion, {
            type: "api",
            message: "Unexpected API response",
          });
        }
      },
    });
  })().catch((err) => {
    handleValidateError(completion, err);
  });
}

function pluginTimeoutInterval() {
  return 60;
}

exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.pluginValidate = pluginValidate;
exports.supportLanguages = supportLanguages;
exports.translate = translate;
