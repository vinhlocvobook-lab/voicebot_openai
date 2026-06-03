## webhook post
    verify
    event=req.body
    event.type="realtime.call.incoming"
        send 200 OK
        _handleIncomingCall

## _handleIncomingCall
    acceptCall
        Setting Tools
    openSessionWebSocket
        
## openSessionWebSocket
    import tool function from /tools.js
    websocket 
        on open
            send response.create
                "Xin chào Quý khách đã gọi đến Tổng đài CNTA"
        on message
            event=JSON.parse(message.toString())
            event.type:
                response.done
                    ?usage->log usage
                    ?outputs
                        output.type="function_call"
                            kqcallfunction=dispatchTool
                            send conversation.item.create
                                item.type="function_call_output
                                output=kqcallfunction
                            result=JSON.parse(kqcallfunction)
                            result.action
                                kiểm tra transfer
                                kiểm tra end_call
                            send response.create
                                nếu transfer -> thông báo
                                nếu end_call -> thông báo
                coversation.item.input_audio_transcription.completed
                    KH nói : event.transcript
                response.audio_transcript.done
                    AI nói : event.transcript
                
            
            
            
