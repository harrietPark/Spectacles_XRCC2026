import {OpenAI} from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI"

@component
export class ChatGPT extends BaseScriptComponent {
  private ImageQuality = CompressionQuality.HighQuality
  private ImageEncoding = EncodingType.Jpg

  onAwake() {}

  makeImageRequest(
    imageTex: Texture,
    callback: (response: string) => void,
    onError?: (reason: string) => void
  ) {
    print("Making image request...")
    Base64.encodeTextureAsync(
      imageTex,
      (base64String) => {
        print("Image encode Success!")
        const textQuery = "Identify in as much detail what object is in the image but only use a maxiumum of 5 words"
        this.sendGPTChat(textQuery, base64String, callback, onError)
      },
      () => {
        print("Image encoding failed!")
        onError?.("image_encode_failed")
      },
      this.ImageQuality,
      this.ImageEncoding
    )
  }

  async sendGPTChat(
    request: string,
    image64: string,
    callback: (response: string) => void,
    onError?: (reason: string) => void
  ) {
    OpenAI.chatCompletions({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {type: "text", text: request},
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,` + image64
              }
            }
          ]
        }
      ],
      max_tokens: 50
    })
      .then((response) => {
        if (response.choices && response.choices.length > 0) {
          const content = response.choices[0].message.content
          if (content != null && content.length > 0) {
            callback(content)
            print("Response from OpenAI: " + content)
            return
          }
        }
        print("OpenAI returned no usable message content")
        onError?.("no_response")
      })
      .catch((error) => {
        print("Error in OpenAI request: " + error)
        onError?.(String(error))
      })
  }
}
