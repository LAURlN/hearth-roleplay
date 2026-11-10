import {Tiktoken} from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';

let encoder;
export function countText(text){
  if(typeof text!=='string')throw new TypeError('Token counting requires text.');
  encoder??=new Tiktoken(ranks);
  // Story text can contain spellings of special tokens. Count them as ordinary
  // authored text rather than granting them tokenizer control semantics.
  return encoder.encode(text,[],[]).length;
}

export function countMessages(messages,_model){
  if(!Array.isArray(messages))throw new TypeError('Token counting requires messages.');
  // Local framing estimate: three tokens per message, one extra for a name,
  // and three for assistant priming. Text uses real o200k BPE. Proxy aliases
  // and server framing can differ, so this is explicitly an estimate.
  let tokens=3;
  for(const message of messages){
    if(!message||typeof message!=='object'||Array.isArray(message))throw new TypeError('Invalid message for token counting.');
    tokens+=3;
    for(const [key,value] of Object.entries(message)){
      if(value===undefined)continue;
      tokens+=countText(typeof value==='string'?value:JSON.stringify(value));
      if(key==='name')tokens++;
    }
  }
  return {tokens,encoding:'o200k_base',approximate:true};
}
