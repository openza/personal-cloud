export function providerDeliveryLabel(command) {
  if(!command)return "";
  if(command.state==="confirmed")return "Provider confirmed";
  if(command.state==="rejected")return `Provider delivery rejected${command.errorCode?` (${command.errorCode.replaceAll("_"," ")})`:""}`;
  if(command.deliveryState==="started")return "Provider delivery started; check Desktop if unfinished";
  return "Waiting for Desktop to deliver to provider";
}
