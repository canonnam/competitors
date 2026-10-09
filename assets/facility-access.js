/* Re-enter the server gate when the browser's map session expires. */
export function checkAccess(response){
  if(response.status===401){
    if(window.FacilityViewer?.readOnly)window.top.location.replace('/');
    else location.replace('/facility-3d.html');
    throw new Error('비밀번호 인증이 필요합니다.');
  }
}
